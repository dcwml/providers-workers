import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRead } from "../../src/read/runner";
import { NonRetryableError, RetryableError } from "../../src/errors";
import type { Env } from "../../src/env";

// runner 在模块加载时构建 READ_CHAIN，因此 mock 的 provider 用「委托 state」模式：
// 对象身份固定，行为在测试里通过 state 切换。
const state = vi.hoisted(() => ({
  jinaImpl: async (_url: string): Promise<{ markdown: string }> => ({ markdown: "jina" }),
  tavilyImpl: async (_url: string): Promise<{ markdown: string }> => ({ markdown: "tavily" }),
  firecrawlImpl: async (_url: string): Promise<{ markdown: string }> => ({ markdown: "fc" }),
}));

vi.mock("../../src/read/providers/jina", () => ({
  jina: { id: "jina", read: (url: string) => state.jinaImpl(url) },
}));
vi.mock("../../src/read/providers/tavily", () => ({
  tavily: { id: "tavily", read: (url: string) => state.tavilyImpl(url) },
}));
vi.mock("../../src/read/providers/firecrawl", () => ({
  firecrawl: { id: "firecrawl", read: (url: string) => state.firecrawlImpl(url) },
}));

const env: Env = { AUTH_TOKENS: "" };
const fast = { delayMs: 0 };

describe("runRead", () => {
  beforeEach(() => {
    state.jinaImpl = async () => ({ markdown: "jina" });
    state.tavilyImpl = async () => ({ markdown: "tavily" });
    state.firecrawlImpl = async () => ({ markdown: "fc" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns jina's markdown when the first provider succeeds", async () => {
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200, markdown: "jina" });
  });

  it("follows the fixed order jina -> tavily -> firecrawl", async () => {
    const calls: string[] = [];
    state.jinaImpl = async () => {
      calls.push("jina");
      throw new NonRetryableError("empty");
    };
    state.tavilyImpl = async () => {
      calls.push("tavily");
      throw new NonRetryableError("empty");
    };
    state.firecrawlImpl = async () => {
      calls.push("firecrawl");
      return { markdown: "fc" };
    };
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome).toMatchObject({ kind: "ok", markdown: "fc" });
    expect(calls).toEqual(["jina", "tavily", "firecrawl"]);
  });

  it("retries a provider 3 times before falling back", async () => {
    let jinaCalls = 0;
    state.jinaImpl = async () => {
      jinaCalls++;
      throw new RetryableError("down");
    };
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome).toMatchObject({ kind: "ok", markdown: "tavily" });
    expect(jinaCalls).toBe(3);
  });

  it("returns 502 with aggregated errors when all providers fail", async () => {
    state.jinaImpl = async () => {
      throw new RetryableError("jina dead");
    };
    state.tavilyImpl = async () => {
      throw new NonRetryableError("tavily empty");
    };
    state.firecrawlImpl = async () => {
      throw new NonRetryableError("fc refused");
    };
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "jina", message: "jina dead" },
      { provider: "tavily", message: "tavily empty" },
      { provider: "firecrawl", message: "fc refused" },
    ]);
  });

  it("logs each attempt with read feature tag", async () => {
    await runRead("https://example.com", env, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[read] provider=jina"));
  });
});
