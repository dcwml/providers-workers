import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import { sanitizeRequest } from "../sanitize";
import type { ChatProvider, ChatResponse } from "../types";

const BASE_URL = "https://api.siliconflow.cn/v1";
const UPSTREAM_MODEL = "Qwen/Qwen3.5-4B";
const ENV_KEY = "SILICONFLOW_API_KEY";

export const siliconflow: ChatProvider = {
  id: "siliconflow",
  // 四项能力均经 scripts/probe.ts 真实上游探测验证（2026-08-18）
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
      throw new RetryableError("siliconflow: response is not valid JSON", { cause: err });
    }
  },
};
