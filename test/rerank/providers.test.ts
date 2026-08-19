import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { siliconflow } from "../../src/rerank/providers/siliconflow";
import type { RerankRequest } from "../../src/rerank/types";
import type { Env } from "../../src/env";

const baseReq: RerankRequest = {
  model: "BAAI/bge-reranker-v2-m3",
  query: "What is deep learning?",
  documents: ["Deep learning is a branch of machine learning.", "It will rain tomorrow."],
};
const signal = new AbortController().signal;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const okBody = {
  id: "01a017f5dc527611ab617cf1a97eff08",
  results: [
    { index: 0, document: null, relevance_score: 0.9998 },
    { index: 1, document: null, relevance_score: 0.0001 },
  ],
  meta: { tokens: { input_tokens: 61, output_tokens: 0 } },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("siliconflow rerank", () => {
  const env: Env = { AUTH_TOKENS: "", SILICONFLOW_API_KEY: "sf-test" };

  it("sends whitelisted body with rewritten model to the siliconflow rerank endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okBody));
    vi.stubGlobal("fetch", fetchMock);
    const req: RerankRequest = {
      ...baseReq,
      model: "any-logical-model",
      top_n: 2,
      return_documents: true,
      bogus: "strip-me",
    };

    const res = await siliconflow.rerank(req, env, signal);

    expect(res).toEqual(okBody); // 响应原样透传
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.siliconflow.cn/v1/rerank");
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      model: "BAAI/bge-reranker-v2-m3", // 改写为上游固定 model
      query: "What is deep learning?",
      documents: [
        "Deep learning is a branch of machine learning.",
        "It will rain tomorrow.",
      ],
      top_n: 2,
      return_documents: true,
    }); // bogus 字段被裁剪
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sf-test");
  });

  it("omits optional fields when absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okBody));
    vi.stubGlobal("fetch", fetchMock);

    await siliconflow.rerank(baseReq, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      model: "BAAI/bge-reranker-v2-m3",
      query: "What is deep learning?",
      documents: [
        "Deep learning is a branch of machine learning.",
        "It will rain tomorrow.",
      ],
    });
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      siliconflow.rerank(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(siliconflow.rerank(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(siliconflow.rerank(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(siliconflow.rerank(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(siliconflow.rerank(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps empty results array to NonRetryableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { id: "x", results: [] })),
    );
    await expect(siliconflow.rerank(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps non-object JSON response to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200 })));
    await expect(siliconflow.rerank(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });
});
