import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { firecrawl } from "../../src/read/providers/firecrawl";
import { jina } from "../../src/read/providers/jina";
import { tavily } from "../../src/read/providers/tavily";
import type { Env } from "../../src/env";

const signal = new AbortController().signal;
const url = "https://example.com/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jina", () => {
  const env: Env = { AUTH_TOKENS: "", JINA_API_KEY: "jina-test" };

  it("GETs r.jina.ai with bearer key and returns markdown body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("# Title\n\ncontent", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await jina.read(url, env, signal);

    expect(result).toEqual({ markdown: "# Title\n\ncontent" });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://r.jina.ai/https://example.com/page");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jina-test");
  });

  it("throws NonRetryableError on empty content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("   ", { status: 200 })));
    await expect(jina.read(url, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("throws NonRetryableError when api key missing", async () => {
    await expect(jina.read(url, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps 500 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    await expect(jina.read(url, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("tavily", () => {
  const env: Env = { AUTH_TOKENS: "", TAVILY_API_KEY: "tvly-test" };

  it("posts urls array and extracts results[0].raw_content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { results: [{ url, raw_content: "# hello" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await tavily.read(url, env, signal);

    expect(result).toEqual({ markdown: "# hello" });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(String(init.body))).toEqual({ urls: [url] });
  });

  it("throws NonRetryableError when results is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { results: [], failed_results: [{ url }] })),
    );
    await expect(tavily.read(url, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "limit" })));
    await expect(tavily.read(url, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("firecrawl", () => {
  const env: Env = { AUTH_TOKENS: "", FIRECRAWL_API_KEY: "fc-test" };

  it("posts v2 scrape and extracts data.markdown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, data: { markdown: "# fc" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await firecrawl.read(url, env, signal);

    expect(result).toEqual({ markdown: "# fc" });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(JSON.parse(String(init.body))).toEqual({ url, formats: ["markdown"] });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fc-test");
  });

  it("throws NonRetryableError when markdown is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { markdown: "" } })),
    );
    await expect(firecrawl.read(url, env, signal)).rejects.toThrow(NonRetryableError);
  });
});
