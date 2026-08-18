import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import { sanitizeRequest } from "../sanitize";
import type { ChatProvider, ChatResponse } from "../types";

const BASE_URL = "https://api.gptsapi.net/v1";
const UPSTREAM_MODEL = "gpt-5.4-nano";
const ENV_KEY = "GPTSAPI_API_KEY";

export const gptsapi: ChatProvider = {
  id: "gptsapi",
  // 四项能力均经 scripts/probe.ts 真实上游探测验证（2026-08-18），
  // json_schema 另经 curl 严格 schema 判别测试确认真被执行（提示词与 schema 冲突时输出服从 schema）
  capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true },
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
      throw new RetryableError("gptsapi: response is not valid JSON", { cause: err });
    }
  },
};
