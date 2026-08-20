import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { siliconflow } from "../../src/embeddings/providers/siliconflow";
import { jina } from "../../src/embeddings/providers/jina";
import type { EmbeddingsRequest } from "../../src/embeddings/types";
import type { Env } from "../../src/env";

const baseReq: EmbeddingsRequest = { model: "BAAI/bge-m3", input: "hello" };
const signal = new AbortController().signal;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const okBody = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
  model: "BAAI/bge-m3",
  usage: { prompt_tokens: 1, total_tokens: 1 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("siliconflow embeddings", () => {
  const env: Env = { AUTH_TOKENS: "", SILICONFLOW_API_KEY: "sf-test" };

  it("sends whitelisted body with rewritten model to the siliconflow embeddings endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okBody));
    vi.stubGlobal("fetch", fetchMock);
    const req: EmbeddingsRequest = {
      ...baseReq,
      model: "any-logical-model",
      encoding_format: "float",
      dimensions: 1024,
      user: "u1",
      bogus: "strip-me",
      task: "retrieval.query",
      normalized: true,
    };

    const res = await siliconflow.embed(req, env, signal);

    expect(res).toEqual(okBody); // 响应原样透传
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.siliconflow.cn/v1/embeddings");
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      model: "BAAI/bge-m3", // 改写为上游固定 model
      input: "hello",
      encoding_format: "float",
      dimensions: 1024,
      user: "u1",
    }); // bogus 与 jina 专属字段（task/normalized）被裁剪
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sf-test");
  });

  it("omits optional fields when absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okBody));
    vi.stubGlobal("fetch", fetchMock);

    await siliconflow.embed({ model: "BAAI/bge-m3", input: ["a", "b"] }, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ model: "BAAI/bge-m3", input: ["a", "b"] });
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      siliconflow.embed(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(siliconflow.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(siliconflow.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(siliconflow.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(siliconflow.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps empty data array to NonRetryableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { object: "list", data: [] })),
    );
    await expect(siliconflow.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps non-object JSON response to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200 })));
    await expect(siliconflow.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });
});

describe("jina embeddings", () => {
  const env: Env = { AUTH_TOKENS: "", JINA_API_KEY: "jina-test" };

  const jinaOkBody = {
    object: "list",
    data: [
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [0.3, 0.4] },
    ],
    model: "jina-embeddings-v5-omni-small",
    usage: { prompt_tokens: 8, image_tokens: 278, total_tokens: 286 },
  };

  it("sends whitelisted body with task/normalized passthrough, rewritten model and multimodal input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, jinaOkBody));
    vi.stubGlobal("fetch", fetchMock);
    const req: EmbeddingsRequest = {
      model: "any-logical-model",
      input: [{ text: "A beautiful sunset over the beach" }, { image: "iVBORw0KGgo" }],
      task: "retrieval.query",
      normalized: true,
      encoding_format: "float",
      dimensions: 1024,
      user: "u1",
      bogus: "strip-me",
    };

    const res = await jina.embed(req, env, signal);

    expect(res).toEqual(jinaOkBody); // 响应原样透传
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.jina.ai/v1/embeddings");
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      model: "jina-embeddings-v5-omni-small", // 改写为上游固定 model
      input: [{ text: "A beautiful sunset over the beach" }, { image: "iVBORw0KGgo" }], // 多模态对象原样透传
      task: "retrieval.query", // jina 专属扩展白名单
      normalized: true, // jina 专属扩展白名单
      encoding_format: "float",
      dimensions: 1024,
      user: "u1",
    }); // bogus 字段被裁剪
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jina-test");
  });

  it("omits optional fields when absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, jinaOkBody));
    vi.stubGlobal("fetch", fetchMock);

    await jina.embed({ model: "jina-embeddings-v5-omni-small", input: ["a", "b"] }, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ model: "jina-embeddings-v5-omni-small", input: ["a", "b"] });
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      jina.embed(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps empty data array to NonRetryableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { object: "list", data: [] })),
    );
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps non-object JSON response to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200 })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });
});
