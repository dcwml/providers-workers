import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import {
  RERANK_MODEL_IDS,
  RERANK_PROVIDER_IDS,
  getRerankProviderById,
  getRerankProviderByModel,
} from "../../src/rerank/models";
import { runRerank } from "../../src/rerank/runner";
import type { RerankProvider, RerankResponse } from "../../src/rerank/types";
import type { Env } from "../../src/env";
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "../helpers";

const env: Env = { AUTH_TOKENS: "" };
const req = { model: "BAAI/bge-reranker-v2-m3", query: "q", documents: ["a", "b"] };
const fast = { delayMs: 0 }; // 测试中跳过 1s 等待

function provider(id: string, rerank: RerankProvider["rerank"]): RerankProvider {
  return { id, rerank };
}

describe("model mapping", () => {
  it("maps BAAI/bge-reranker-v2-m3 to siliconflow", () => {
    expect(getRerankProviderByModel("BAAI/bge-reranker-v2-m3")?.id).toBe("siliconflow");
  });

  it("returns undefined for unknown model (no fallback chain)", () => {
    expect(getRerankProviderByModel("nope")).toBeUndefined();
  });

  it("exposes model ids and provider ids for error messages", () => {
    expect(RERANK_MODEL_IDS).toEqual(["BAAI/bge-reranker-v2-m3"]);
    expect(RERANK_PROVIDER_IDS).toEqual(["siliconflow"]);
    expect(getRerankProviderById("siliconflow")?.id).toBe("siliconflow");
    expect(getRerankProviderById("bogus")).toBeUndefined();
  });
});

describe("runRerank", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns provider response on success (pass-through)", async () => {
    const body: RerankResponse = { results: [{ index: 0, relevance_score: 0.9 }] };
    const outcome = await runRerank(req, env, provider("p1", async () => body), fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200, body });
  });

  it("retries retryable errors then fails with 502 and provider error (no fallback)", async () => {
    let calls = 0;
    const p = provider("p1", async () => {
      calls++;
      throw new RetryableError("down");
    });
    const outcome = await runRerank(req, env, p, fast);
    expect(outcome.kind).toBe("failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([{ provider: "p1", message: "down" }]);
    expect(calls).toBe(3); // DEFAULT_RETRY maxAttempts
  });

  it("fails immediately without retrying on NonRetryableError", async () => {
    let calls = 0;
    const p = provider("p1", async () => {
      calls++;
      throw new NonRetryableError("bad request");
    });
    const outcome = await runRerank(req, env, p, fast);
    expect(outcome.kind).toBe("failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([{ provider: "p1", message: "bad request" }]);
    expect(calls).toBe(1);
  });

  it("logs each attempt under the rerank feature tag", async () => {
    const p = provider("p1", async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }));
    await runRerank(req, env, p, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[rerank] provider=p1"));
  });

  it("records attempts via recorder and reports providerOk on success", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const recorder = new RequestRecorder(c.ctx, d1.db, {
      requestId: "r4", feature: "rerank", endpoint: "/v1/rerank", model: "BAAI/bge-reranker-v2-m3", tokenId: 1,
    });
    const p = provider("p1", async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }));
    const outcome = await runRerank(req, env, p, fast, recorder);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("p1");
    await Promise.all(c.promises);
    const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.params).toEqual(["r4", "rerank", "p1", "BAAI/bge-reranker-v2-m3", 1, "ok", expect.any(Number), null]);
  });
});
