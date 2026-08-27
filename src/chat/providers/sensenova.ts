import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import { sanitizeRequest } from "../sanitize";
import type { ChatProvider, ChatResponse } from "../types";

const BASE_URL = "https://token.sensenova.cn/v1";
const UPSTREAM_MODEL = "sensenova-6.8-flash-lite";
const ENV_KEY = "SENSENOVA_API_KEY";

export const sensenova: ChatProvider = {
  id: "sensenova",
  // 四项能力经 scripts/probe.ts 探测 + curl 判别实测验证（2026-08-27）：
  // systemPrompt=true（probe supported）
  // tools=true（probe supported，实际返回 get_weather tool_calls，行为已验证）
  // jsonObject=true（curl 复测 200 耗时 22.7s，content 为合法 JSON {"ok": true}；probe 首测 30s 超时系默认思考模式耗时所致）
  // jsonSchema=false（probe rejected + fruit=banana 严格 schema 判别双重确认：上游 400
  //   guided_grammar compile_grammar_error: No module named 'xgrammar'，参数形状整体不被支持，sanitize 自动降级 json_object）
  // 运维观察：默认开思考模式，响应含 reasoning 字段，单次耗时可达 22s+，接近网关 30s 超时上限
  capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: false },
  async chat(req, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    const body = sanitizeRequest(req, this.capabilities);
    body.model = UPSTREAM_MODEL;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);
    try {
      return JSON.parse(text) as ChatResponse;
    } catch (err) {
      throw new RetryableError("sensenova: response is not valid JSON", { cause: err });
    }
  },
};
