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
  // 四项能力经 scripts/probe.ts 探测 + curl 判别实测验证（2026-08-20）：
  // systemPrompt=true（curl 复测 200，content 仅 "pong"，system 消息生效）
  // tools=true（curl 复测 200 且实际返回 get_weather tool_calls，行为已验证）
  // jsonObject=true（curl 复测 200，content 为合法 JSON，且上游注入 JSON 模式提示词）
  // jsonSchema=false（判别测试：提示词与 schema 无关、fruit 仅允许 "banana"，请求被 200 接受
  //   但 content 为自由文本自我介绍 → schema 被忽略，sanitize 自动降级 json_object）
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
      throw new RetryableError("zhipu: response is not valid JSON", { cause: err });
    }
  },
};
