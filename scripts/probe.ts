/**
 * 用法：npm run probe -- <providerId>
 *
 * 对指定 chat provider 实测四项能力（systemPrompt / tools / jsonObject / jsonSchema），
 * 输出建议的 capabilities 配置。会发起真实的上游请求（各 1 次，共 4 次）。
 *
 * 密钥来源：项目根目录 .dev.vars（不存在则忽略），进程环境变量可补充。
 */
import { existsSync, readFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { resolve } from "node:path";
import { CHAINS } from "../src/chat/chains";
import { probeProvider, type ProbeDetail } from "../src/chat/probe";
import type { ChatProvider } from "../src/chat/types";
import type { Env } from "../src/env";

function parseDevVars(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function findProvider(id: string): ChatProvider | undefined {
  for (const chain of Object.values(CHAINS)) {
    const hit = chain.find((p) => p.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function allProviderIds(): string[] {
  const ids = new Set<string>();
  for (const chain of Object.values(CHAINS)) {
    for (const p of chain) ids.add(p.id);
  }
  return [...ids];
}

function formatDetail(d: ProbeDetail): string {
  const mark =
    d.status === "supported" ? "[supported]  " : d.status === "rejected" ? "[rejected]    " : "[inconclusive]";
  return d.note ? `${mark} ${d.note}` : mark;
}

const providerId = argv[2];
if (!providerId) {
  console.error(`用法: npm run probe -- <providerId>\n当前已注册的 provider: ${allProviderIds().join(", ")}`);
  exit(1);
}

const provider = findProvider(providerId);
if (!provider) {
  console.error(`未找到 provider "${providerId}"（需在 src/chat/chains.ts 的 CHAINS 中注册）`);
  console.error(`当前已注册的 provider: ${allProviderIds().join(", ")}`);
  exit(1);
}

const env = { ...parseDevVars(resolve(process.cwd(), ".dev.vars")) } as Env & Record<string, string>;
for (const key of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "AGNES_API_KEY"]) {
  if (env[key] === undefined && process.env[key] !== undefined) {
    env[key] = process.env[key];
  }
}

console.log(`探测 provider "${provider.id}"，将发起 4 次真实上游请求...\n`);
const outcome = await probeProvider(provider, env);

for (const [key, detail] of Object.entries(outcome.details) as [string, ProbeDetail][]) {
  console.log(`${key.padEnd(14)}${formatDetail(detail)}`);
}

const s = outcome.suggested;
console.log(`\n建议配置（src/chat/providers/ 中该 provider 的 capabilities）：`);
console.log(
  `  capabilities: { systemPrompt: ${s.systemPrompt}, tools: ${s.tools}, jsonObject: ${s.jsonObject}, jsonSchema: ${s.jsonSchema} }`,
);
if (Object.values(outcome.details).some((d) => d.status === "inconclusive")) {
  console.log(`\n注意：存在 inconclusive 项（网络错误/5xx/超时或密钥未配置），相关结论建议人工复核。`);
}
