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
// 上游为商汤托管的 glm-5.2（Z.ai 系）；逻辑链键名保留 "sensenova-6.8-flash-lite" 兼容既有调用方
const UPSTREAM_MODEL = "glm-5.2";
const ENV_KEY = "SENSENOVA_API_KEY";

export const sensenova: ChatProvider = {
  id: "sensenova",
  // 四项能力经 scripts/probe.ts 探测 + curl 判别实测验证（glm-5.2，2026-08-27）：
  // systemPrompt=true（curl 复测 200，content 仅 "pong"，system 消息生效；probe 首测 429 配额后复测）
  // tools=true（probe supported，实际返回 tool_calls，行为已验证）
  // jsonObject=true（probe supported，输出为合法 JSON）
  // jsonSchema=true（fruit=banana 严格 schema 判别：提示词仅要求自我介绍，思考过程未提 banana，
  //   content 却输出符合 schema 的 {"fruit":"banana",...}——解码层真执行约束，非被忽略）
  // 历史：上游原为 sensenova-6.8-flash-lite（jsonSchema=false，引擎缺 xgrammar 400；见 2026-08-27 完成报告）
  // 运维观察：glm-5.2 思考字段名为 reasoning_content，单次 1-11s；商汤工作区配额窗口较紧，
  //   连续请求易 429 insufficient_quota（分钟级恢复，网关重试间隔 1s 可能仍在窗口内→耗尽后降级下家）
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
      throw new RetryableError("sensenova: response is not valid JSON", { cause: err });
    }
  },
};
