import { describe, expect, it } from "vitest";
import { probeProvider } from "../../src/chat/probe";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/chat/types";
import type { Env } from "../../src/env";
import { NonRetryableError, RetryableError } from "../../src/errors";

const env = {} as Env;

/** 声明全 false 能力、记录收到的请求，并由 handler 决定成功/抛错的假 provider */
function fakeProvider(
  handler: (req: ChatRequest, call: number) => ChatResponse | Promise<ChatResponse>,
): { provider: ChatProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = {
    id: "fake",
    capabilities: { systemPrompt: false, tools: false, jsonObject: false, jsonSchema: false },
    async chat(req) {
      requests.push(req);
      return handler(req, requests.length);
    },
  };
  return { provider, requests };
}

const okResponse = (content: string): ChatResponse => ({
  choices: [{ message: { role: "assistant", content } }],
});

const toolCallResponse: ChatResponse = {
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
    },
  ],
};

describe("probeProvider", () => {
  it("全部通过时建议全 true，且探测请求不被 sanitize 裁剪", async () => {
    const { provider, requests } = fakeProvider((req) => {
      if (req.tools) return toolCallResponse;
      return okResponse('{"ok":true}');
    });

    const outcome = await probeProvider(provider, env);

    expect(outcome.suggested).toEqual({
      systemPrompt: true,
      tools: true,
      jsonObject: true,
      jsonSchema: true,
    });
    expect(outcome.details.systemPrompt.status).toBe("supported");
    expect(outcome.details.tools.note).toContain("tool_calls");
    expect(outcome.details.jsonObject.note).toContain("合法 JSON");

    // 尽管声明的 capabilities 全为 false，system/tools/response_format 都原样到达 provider
    expect(requests).toHaveLength(4);
    expect(requests.some((r) => r.messages.some((m) => m.role === "system"))).toBe(true);
    expect(requests.some((r) => Array.isArray(r.tools))).toBe(true);
    expect(requests.filter((r) => r.response_format?.type === "json_object")).toHaveLength(1);
    expect(requests.filter((r) => r.response_format?.type === "json_schema")).toHaveLength(1);
  });

  it("非 4xx 可重试类错误（如 400）判定 rejected 且建议 false", async () => {
    const { provider } = fakeProvider((req) => {
      if (req.response_format?.type === "json_schema") {
        throw new NonRetryableError("upstream 400: response_format not supported");
      }
      return okResponse('{"ok":true}');
    });

    const outcome = await probeProvider(provider, env);

    expect(outcome.details.jsonSchema.status).toBe("rejected");
    expect(outcome.suggested.jsonSchema).toBe(false);
    expect(outcome.suggested.systemPrompt).toBe(true);
  });

  it("网络错误/5xx 判定 inconclusive 且建议 false", async () => {
    const { provider } = fakeProvider(() => {
      throw new RetryableError("network error: timeout");
    });

    const outcome = await probeProvider(provider, env);

    for (const detail of Object.values(outcome.details)) {
      expect(detail.status).toBe("inconclusive");
    }
    expect(outcome.suggested).toEqual({
      systemPrompt: false,
      tools: false,
      jsonObject: false,
      jsonSchema: false,
    });
  });

  it("密钥未配置判定 inconclusive 而非 rejected", async () => {
    const { provider } = fakeProvider(() => {
      throw new NonRetryableError("FAKE_API_KEY is not configured");
    });

    const outcome = await probeProvider(provider, env);

    expect(outcome.details.systemPrompt.status).toBe("inconclusive");
    expect(outcome.details.systemPrompt.note).toContain("not configured");
  });

  it("探测结束后恢复 provider 原有的 capabilities 声明", async () => {
    const original = { systemPrompt: false, tools: false, jsonObject: true, jsonSchema: false };
    const { provider } = fakeProvider(() => okResponse("ok"));
    provider.capabilities = { ...original };

    await probeProvider(provider, env);

    expect(provider.capabilities).toEqual(original);
  });
});
