/**
 * 本地开发服务器（Node 直跑 worker handler，不依赖 wrangler，Node >= 20）。
 * 用法：npx tsx scripts/serve.ts   （默认 http://localhost:8787，PORT 可覆盖）
 * 密钥来源同 probe：项目根目录 .dev.vars。
 * 注意：D1 改造后本服务无数据库（鉴权路径 500），本地联调请优先 npm run dev。
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import worker from "../src/index";
import type { WorkerEnv } from "../src/env";
import type { ExecutionContext } from "@cloudflare/workers-types";

function loadDevVars(): Record<string, string> {
  const path = resolve(process.cwd(), ".dev.vars");
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

const env = loadDevVars() as WorkerEnv & Record<string, string>;
// Node 环境没有 D1 binding：业务端点会因鉴权查不到 DB 返回 500（auth store unavailable），
// 此服务仅剩 404/管理页等非鉴权路径可用。本地联调请用 npm run dev（wrangler 提供 D1）。
const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const port = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
    const body = await new Promise<Buffer | undefined>((resolveBody) => {
      if (req.method !== "POST") return resolveBody(undefined);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolveBody(Buffer.concat(chunks)));
      req.on("error", () => resolveBody(undefined));
    });

    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      // @ts-expect-error Node 的 undici 支持.duplex，类型定义滞后
      duplex: "half",
    });
    const response = await worker.fetch(request, env, ctx);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? err.stack : String(err));
  }
});

server.listen(port, () => {
  console.log(`listening on http://localhost:${port}`);
});
