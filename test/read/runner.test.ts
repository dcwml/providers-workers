import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRead } from "../../src/read/runner";
import { NonRetryableError, RetryableError } from "../../src/errors";
import type { Env } from "../../src/env";
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "../helpers";
import { firecrawl } from "../../src/read/providers/firecrawl";
import { jina } from "../../src/read/providers/jina";

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

  describe("provider override (only)", () => {
    it("runs only the specified provider even if an earlier one would succeed", async () => {
      const calls: string[] = [];
      state.jinaImpl = async () => {
        calls.push("jina");
        return { markdown: "jina" };
      };
      state.firecrawlImpl = async () => {
        calls.push("firecrawl");
        return { markdown: "fc" };
      };
      const outcome = await runRead("https://example.com", env, fast, firecrawl);
      expect(outcome).toMatchObject({ kind: "ok", markdown: "fc" });
      expect(calls).toEqual(["firecrawl"]);
    });

    it("does not fall back when the only provider fails", async () => {
      const calls: string[] = [];
      state.jinaImpl = async () => {
        calls.push("jina");
        throw new NonRetryableError("jina empty");
      };
      state.tavilyImpl = async () => {
        calls.push("tavily");
        return { markdown: "tavily" };
      };
      const outcome = await runRead("https://example.com", env, fast, jina);
      expect(outcome.kind).toBe("all-failed");
      expect(outcome.status).toBe(502);
      expect(outcome.errors).toEqual([{ provider: "jina", message: "jina empty" }]);
      expect(calls).toEqual(["jina"]);
    });
  });

  it("records attempts via recorder and reports providerOk on success", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const recorder = new RequestRecorder(c.ctx, d1.db, {
      requestId: "r2", feature: "read", endpoint: "/v1/read", model: "", tokenId: 1,
    });
    const outcome = await runRead("https://example.com", env, fast, undefined, recorder);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("jina");
    await Promise.all(c.promises);
    const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.params).toEqual(["r2", "read", "jina", "", 1, "ok", expect.any(Number), null]);
  });
});
