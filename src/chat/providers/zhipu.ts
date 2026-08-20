import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import { sanitizeRequest } from "../sanitize";
import type { ChatProvider, ChatResponse } from "../types";

const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const UPSTREAM_MODEL = "glm-4.7-flash";
const ENV_KEY = "ZHIPU_API_KEY";

export const zhipu: ChatProvider = {
  id: "zhipu",
  // 占位全 true，待 scripts/probe.ts 实测校准（见实施计划 Task 3）
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
      throw new RetryableError("zhipu: response is not valid JSON", { cause: err });
    }
  },
};
