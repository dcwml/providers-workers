import { UPSTREAM_TIMEOUT_MS } from "../config";
import { NonRetryableError } from "../errors";
import type { Env } from "../env";
import type { Capabilities, ChatProvider, ChatRequest, ChatResponse } from "./types";

export type ProbeStatus = "supported" | "rejected" | "inconclusive";

export type CapabilityKey = keyof Capabilities;

export interface ProbeDetail {
  status: ProbeStatus;
  /** 附加说明：被拒原因 / 是否验证了输出等 */
  note?: string;
}

export interface ProbeOutcome {
  providerId: string;
  details: Record<CapabilityKey, ProbeDetail>;
  /** 仅把 status === "supported" 的项置 true；inconclusive 一律建议 false 并需人工复核 */
  suggested: Capabilities;
}

/** 探测时临时使用的全能力配置，保证 sanitize 不裁剪任何字段 */
const ALL_TRUE: Capabilities = {
  systemPrompt: true,
  tools: true,
  jsonObject: true,
  jsonSchema: true,
};

function extractMessage(res: ChatResponse): { content?: string; toolCalls?: unknown[] } {
  const choices = res.choices;
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const first = choices[0] as { message?: { content?: unknown; tool_calls?: unknown } };
  const content = first.message?.content;
  return {
    content: typeof content === "string" ? content : undefined,
    toolCalls: Array.isArray(first.message?.tool_calls) ? (first.message?.tool_calls as unknown[]) : undefined,
  };
}

/** 每个能力对应一个最小探测请求 */
function buildProbeRequest(key: CapabilityKey): ChatRequest {
  switch (key) {
    case "systemPrompt":
      return {
        model: "probe",
        messages: [
          { role: "system", content: 'You are a test bot. Reply only with the single word "pong".' },
          { role: "user", content: "ping" },
        ],
      };
    case "tools":
      return {
        model: "probe",
        messages: [{ role: "user", content: "What is the weather in Paris? Call the get_weather tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: "auto",
      };
    case "jsonObject":
      return {
        model: "probe",
        messages: [{ role: "user", content: 'Return exactly this JSON object: {"ok": true}' }],
        response_format: { type: "json_object" },
      };
    case "jsonSchema":
      return {
        model: "probe",
        messages: [{ role: "user", content: 'Return an object with a single boolean field "ok" set to true.' }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "ok_object",
            strict: true,
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        },
      };
  }
}

async function runOne(
  provider: ChatProvider,
  env: Env,
  key: CapabilityKey,
): Promise<ProbeDetail> {
  try {
    const res = await provider.chat(buildProbeRequest(key), env, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS));
    const { content, toolCalls } = extractMessage(res);

    if (key === "tools") {
      return toolCalls && toolCalls.length > 0
        ? { status: "supported", note: "模型返回了 tool_calls" }
        : { status: "supported", note: "请求被接受（本次未返回 tool_calls，输出行为未验证）" };
    }
    if (key === "jsonObject" || key === "jsonSchema") {
      if (content !== undefined) {
        try {
          JSON.parse(content);
          return { status: "supported", note: "输出为合法 JSON" };
        } catch {
          return { status: "supported", note: "请求被接受，但输出不是合法 JSON，建议人工复核" };
        }
      }
      return { status: "supported", note: "请求被接受（响应中无文本 content，输出行为未验证）" };
    }
    return { status: "supported" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NonRetryableError) {
      // 密钥未配置属于环境问题，不算"不支持"
      if (/is not configured$/.test(message)) {
        return { status: "inconclusive", note: message };
      }
      return { status: "rejected", note: message };
    }
    // RetryableError（429/5xx/网络错/超时）等：无法判断
    return { status: "inconclusive", note: message };
  }
}

/**
 * 实测一个 provider 的四项能力。
 * 临时把 capabilities 置为全 true，让 sanitizeRequest 原样透传探测请求，
 * 结束后恢复原值。串行执行共 4 次真实上游调用。
 */
export async function probeProvider(provider: ChatProvider, env: Env): Promise<ProbeOutcome> {
  const original = provider.capabilities;
  provider.capabilities = { ...ALL_TRUE };
  try {
    const details = {} as Record<CapabilityKey, ProbeDetail>;
    for (const key of Object.keys(ALL_TRUE) as CapabilityKey[]) {
      details[key] = await runOne(provider, env, key);
    }
    const suggested: Capabilities = {
      systemPrompt: details.systemPrompt.status === "supported",
      tools: details.tools.status === "supported",
      jsonObject: details.jsonObject.status === "supported",
      jsonSchema: details.jsonSchema.status === "supported",
    };
    return { providerId: provider.id, details, suggested };
  } finally {
    provider.capabilities = original;
  }
}
