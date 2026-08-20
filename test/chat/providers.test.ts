import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { deepseekOfficial } from "../../src/chat/providers/deepseek-official";
import { gptsapi } from "../../src/chat/providers/gptsapi";
import { openrouter } from "../../src/chat/providers/openrouter";
import { siliconflow } from "../../src/chat/providers/siliconflow";
import { zhipu } from "../../src/chat/providers/zhipu";
import type { ChatRequest } from "../../src/chat/types";
import type { Env } from "../../src/env";

const baseReq: ChatRequest = {
  model: "sample-chat",
  messages: [{ role: "user", content: "hi" }],
};
const signal = new AbortController().signal;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deepseekOfficial", () => {
  const env: Env = { AUTH_TOKENS: "", DEEPSEEK_API_KEY: "sk-test" };

  it("sends sanitized body with rewritten model to hardcoded upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r1", choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
      tools: [{ type: "function" }],
    };

    const res = await deepseekOfficial.chat(req, env, signal);

    expect(res).toEqual({ id: "r1", choices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("deepseek-chat"); // 改写为上游 model
    expect(sent.response_format).toEqual({ type: "json_object" }); // jsonSchema 不支持 → 降级
    expect(sent.tools).toEqual([{ type: "function" }]); // tools 支持 → 保留
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      deepseekOfficial.chat(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(deepseekOfficial.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(deepseekOfficial.chat(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(deepseekOfficial.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("openrouter", () => {
  const env: Env = { AUTH_TOKENS: "", OPENROUTER_API_KEY: "or-test" };

  it("keeps json_schema as-is and uses the openrouter endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r2" }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
    };

    await openrouter.chat(req, env, signal);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("openai/gpt-4o-mini");
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "s" } });
  });
});

describe("siliconflow", () => {
  const env: Env = { AUTH_TOKENS: "", SILICONFLOW_API_KEY: "sf-test" };

  it("sends sanitized body with rewritten model to the siliconflow endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r3", choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
      tools: [{ type: "function" }],
    };

    const res = await siliconflow.chat(req, env, signal);

    expect(res).toEqual({ id: "r3", choices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.siliconflow.cn/v1/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("Qwen/Qwen3.5-4B"); // 改写为上游 model
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "s" } }); // jsonSchema 实测支持 → 原样保留
    expect(sent.tools).toEqual([{ type: "function" }]); // tools 支持 → 保留
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sf-test");
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      siliconflow.chat(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(siliconflow.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(siliconflow.chat(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(siliconflow.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(siliconflow.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("gptsapi", () => {
  const env: Env = { AUTH_TOKENS: "", GPTSAPI_API_KEY: "gp-test" };

  it("sends sanitized body with rewritten model to the gptsapi endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r4", choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
      tools: [{ type: "function" }],
    };

    const res = await gptsapi.chat(req, env, signal);

    expect(res).toEqual({ id: "r4", choices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.gptsapi.net/v1/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("gpt-5.4-nano"); // 改写为上游 model
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "s" } }); // jsonSchema 实测支持 → 原样保留
    expect(sent.tools).toEqual([{ type: "function" }]); // tools 支持 → 保留
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gp-test");
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      gptsapi.chat(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(gptsapi.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(gptsapi.chat(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(gptsapi.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(gptsapi.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("zhipu", () => {
  const env: Env = { AUTH_TOKENS: "", ZHIPU_API_KEY: "zp-test" };

  it("sends sanitized body with rewritten model to the zhipu endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r5", choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
      tools: [{ type: "function" }],
    };

    const res = await zhipu.chat(req, env, signal);

    expect(res).toEqual({ id: "r5", choices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("glm-4.7-flash"); // 改写为上游 model
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "s" } }); // capabilities 全 true（占位）→ 原样保留
    expect(sent.tools).toEqual([{ type: "function" }]); // tools 支持 → 保留
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer zp-test");
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(zhipu.chat(baseReq, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });
});
