import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSearch } from "../../src/search/runner";
import { NonRetryableError, RetryableError } from "../../src/errors";
import type { Env } from "../../src/env";
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "../helpers";

// runner 在模块加载时构建 SEARCH_CHAIN，因此 mock 的 provider 用「委托 state」模式。
const state = vi.hoisted(() => ({
  anysearchImpl: async (): Promise<{ body: unknown }> => ({ body: { code: 0, data: { results: [] } } }),
}));

vi.mock("../../src/search/providers/anysearch", () => ({
  anysearch: { id: "anysearch", search: () => state.anysearchImpl() },
}));

const env: Env = {};
const fast = { delayMs: 0 };

describe("runSearch", () => {
  beforeEach(() => {
    state.anysearchImpl = async () => ({ body: { code: 0, data: { results: [{ title: "hit" }] } } });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the provider's body on success with providerOk", async () => {
    const outcome = await runSearch({ query: "q" }, env, fast);
    expect(outcome.kind).toBe("ok");
    expect(outcome.status).toBe(200);
    expect(outcome.providerOk).toBe("anysearch");
    expect(outcome.body).toEqual({ code: 0, data: { results: [{ title: "hit" }] } });
  });

  it("retries a retryable failure 3 times before giving up on the provider", async () => {
    let calls = 0;
    state.anysearchImpl = async () => {
      calls++;
      throw new RetryableError("down");
    };
    const outcome = await runSearch({ query: "q" }, env, fast);
    expect(outcome.kind).toBe("all-failed");
    expect(calls).toBe(3);
  });

  it("does not retry a non-retryable failure", async () => {
    let calls = 0;
    state.anysearchImpl = async () => {
      calls++;
      throw new NonRetryableError("bad request");
    };
    const outcome = await runSearch({ query: "q" }, env, fast);
    expect(outcome.kind).toBe("all-failed");
    expect(calls).toBe(1);
  });

  it("returns 502 with aggregated errors when the chain fails", async () => {
    state.anysearchImpl = async () => {
      throw new RetryableError("anysearch dead");
    };
    const outcome = await runSearch({ query: "q" }, env, fast);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([{ provider: "anysearch", message: "anysearch dead" }]);
  });

  it("logs each attempt with search feature tag", async () => {
    await runSearch({ query: "q" }, env, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[search] provider=anysearch"));
  });

  describe("provider override (only)", () => {
    it("runs only the specified provider", async () => {
      const only = { id: "anysearch", search: async () => ({ body: { code: 0 } }) };
      const outcome = await runSearch({ query: "q" }, env, fast, only);
      expect(outcome.kind).toBe("ok");
      expect(outcome.providerOk).toBe("anysearch");
    });

    it("does not fall back when the only provider fails", async () => {
      const only = {
        id: "anysearch",
        search: async () => {
          throw new NonRetryableError("nope");
        },
      };
      const outcome = await runSearch({ query: "q" }, env, fast, only);
      expect(outcome.kind).toBe("all-failed");
      expect(outcome.errors).toEqual([{ provider: "anysearch", message: "nope" }]);
    });
  });

  it("records attempts via recorder", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const recorder = new RequestRecorder(c.ctx, d1.db, {
      requestId: "r3", feature: "search", endpoint: "/v1/search", model: "", tokenId: 1,
    });
    const outcome = await runSearch({ query: "q" }, env, fast, undefined, recorder);
    expect(outcome.kind).toBe("ok");
    await Promise.all(c.promises);
    const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.params).toEqual(["r3", "search", "anysearch", "", 1, "ok", expect.any(Number), null]);
  });
});
