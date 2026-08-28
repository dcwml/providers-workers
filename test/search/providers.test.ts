import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { anysearch } from "../../src/search/providers/anysearch";
import { firecrawl } from "../../src/search/providers/firecrawl";
import type { Env } from "../../src/env";

const signal = new AbortController().signal;
const req = { query: "Go 1.26 release notes" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const okEnvelope = {
  code: 0,
  message: "ok",
  data: {
    results: [{ title: "Go 1.26 - Release Notes", url: "https://go.dev/doc/go1.26", content: "..." }],
    metadata: { total_results: 1, search_time_ms: 320 },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anysearch", () => {
  const env: Env = { ANYSEARCH_API_KEY: "as-test" };

  it("POSTs /v1/search with bearer key and query, passes envelope through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okEnvelope));
    vi.stubGlobal("fetch", fetchMock);

    const result = await anysearch.search(req, env, signal);

    expect(result.body).toEqual(okEnvelope);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://api.anysearch.com/v1/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer as-test");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ query: "Go 1.26 release notes" });
  });

  it("sends max_results when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okEnvelope));
    vi.stubGlobal("fetch", fetchMock);

    await anysearch.search({ query: "q", maxResults: 5 }, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ query: "q", max_results: 5 });
  });

  it("calls anonymously without authorization header when key is missing (upstream supports it)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okEnvelope));
    vi.stubGlobal("fetch", fetchMock);

    const result = await anysearch.search(req, {}, signal);

    expect(result.body).toEqual(okEnvelope);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("returns envelope with empty results as a valid response", async () => {
    const envelope = {
      code: 0,
      message: "ok",
      data: { results: [], metadata: { total_results: 0, search_time_ms: 100 } },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, envelope)));

    const result = await anysearch.search(req, env, signal);
    expect(result.body).toEqual(envelope);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { code: 429, message: "rate limited" })));
    await expect(anysearch.search(req, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 500 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, "oops")));
    await expect(anysearch.search(req, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { code: 1001, message: "invalid query" })),
    );
    await expect(anysearch.search(req, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 })));
    await expect(anysearch.search(req, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps envelope code !== 0 with HTTP 200 to RetryableError carrying upstream message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { code: 4029, message: "quota exhausted", data: null })),
    );
    await expect(anysearch.search(req, env, signal)).rejects.toThrow("quota exhausted");
  });

  it("maps network failure via classifyNetworkError (RetryableError)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(anysearch.search(req, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("firecrawl", () => {
  const env: Env = { FIRECRAWL_API_KEY: "fc-test" };

  const okEnvelope = {
    success: true,
    data: {
      web: [
        { title: "Go 1.26 - Release Notes", description: "...", url: "https://go.dev/doc/go1.26" },
      ],
    },
    creditsUsed: 2,
  };

  it("POSTs /v2/search with bearer key and query, passes envelope through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okEnvelope));
    vi.stubGlobal("fetch", fetchMock);

    const result = await firecrawl.search(req, env, signal);

    expect(result.body).toEqual(okEnvelope);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://api.firecrawl.dev/v2/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fc-test");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ query: "Go 1.26 release notes" });
  });

  it("maps maxResults to limit when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, okEnvelope));
    vi.stubGlobal("fetch", fetchMock);

    await firecrawl.search({ query: "q", maxResults: 5 }, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ query: "q", limit: 5 });
  });

  it("throws NonRetryableError when key is missing", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(firecrawl.search(req, {}, signal)).rejects.toThrow(NonRetryableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns envelope with empty results as a valid response", async () => {
    const envelope = { success: true, data: { web: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, envelope)));

    const result = await firecrawl.search(req, env, signal);
    expect(result.body).toEqual(envelope);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { success: false, error: "rate limited" })));
    await expect(firecrawl.search(req, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 500 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, "oops")));
    await expect(firecrawl.search(req, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { success: false, error: "invalid query" })),
    );
    await expect(firecrawl.search(req, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 })));
    await expect(firecrawl.search(req, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps success !== true with HTTP 200 to RetryableError carrying upstream message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { success: false, error: "Request timed out" })),
    );
    await expect(firecrawl.search(req, env, signal)).rejects.toThrow("Request timed out");
  });

  it("maps network failure via classifyNetworkError (RetryableError)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(firecrawl.search(req, env, signal)).rejects.toThrow(RetryableError);
  });
});
