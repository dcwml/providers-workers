import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import {
  EMBEDDING_MODEL_IDS,
  EMBEDDINGS_PROVIDER_IDS,
  getEmbeddingsProviderById,
  getEmbeddingsProviderByModel,
} from "../../src/embeddings/models";
import { runEmbeddings } from "../../src/embeddings/runner";
import type { EmbeddingsProvider, EmbeddingsResponse } from "../../src/embeddings/types";
import type { Env } from "../../src/env";

const env: Env = { AUTH_TOKENS: "" };
const req = { model: "BAAI/bge-m3", input: "hi" };
const fast = { delayMs: 0 }; // 测试中跳过 1s 等待

function provider(id: string, embed: EmbeddingsProvider["embed"]): EmbeddingsProvider {
  return { id, embed };
}

describe("model mapping", () => {
  it("maps BAAI/bge-m3 to siliconflow", () => {
    expect(getEmbeddingsProviderByModel("BAAI/bge-m3")?.id).toBe("siliconflow");
  });

  it("returns undefined for unknown model (no fallback chain)", () => {
    expect(getEmbeddingsProviderByModel("nope")).toBeUndefined();
  });

  it("exposes model ids and provider ids for error messages", () => {
    expect(EMBEDDING_MODEL_IDS).toEqual(["BAAI/bge-m3"]);
    expect(EMBEDDINGS_PROVIDER_IDS).toEqual(["siliconflow"]);
    expect(getEmbeddingsProviderById("siliconflow")?.id).toBe("siliconflow");
    expect(getEmbeddingsProviderById("bogus")).toBeUndefined();
  });
});

describe("runEmbeddings", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns provider response on success (pass-through)", async () => {
    const body: EmbeddingsResponse = { data: [{ embedding: [1] }] };
    const outcome = await runEmbeddings(req, env, provider("p1", async () => body), fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200, body });
  });

  it("retries retryable errors then fails with 502 and provider error (no fallback)", async () => {
    let calls = 0;
    const p = provider("p1", async () => {
      calls++;
      throw new RetryableError("down");
    });
    const outcome = await runEmbeddings(req, env, p, fast);
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
    const outcome = await runEmbeddings(req, env, p, fast);
    expect(outcome.kind).toBe("failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([{ provider: "p1", message: "bad request" }]);
    expect(calls).toBe(1);
  });

  it("logs each attempt under the embeddings feature tag", async () => {
    const p = provider("p1", async () => ({ data: [{ embedding: [1] }] }));
    await runEmbeddings(req, env, p, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[embeddings] provider=p1"));
  });
});
