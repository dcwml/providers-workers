import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptInfo } from "../src/retry";
import {
  featureFromEndpoint,
  INSERT_ATTEMPT_SQL,
  INSERT_REQUEST_SQL,
  recordUnauthorized,
  RequestRecorder,
  type RecorderMeta,
} from "../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "./helpers";

const meta: RecorderMeta = {
  requestId: "req-1",
  feature: "chat",
  endpoint: "/v1/chat/completions",
  model: "m1",
  tokenId: 7,
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RequestRecorder.attempt", () => {
  it("keeps the console.log line and writes one provider_attempts row via waitUntil", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    const info: AttemptInfo = { attempt: 2, result: "retry", elapsedMs: 12, error: new Error("boom") };
    rec.attempt("agnes", info);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("provider=agnes"));
    await Promise.all(c.promises);
    expect(d1.statements).toHaveLength(1);
    expect(d1.statements[0]?.sql).toBe(INSERT_ATTEMPT_SQL);
    expect(d1.statements[0]?.params).toEqual(["req-1", "chat", "agnes", "m1", 2, "retry", 12, "boom"]);
  });

  it("writes null error on success attempts", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.attempt("agnes", { attempt: 1, result: "ok", elapsedMs: 5 });
    await Promise.all(c.promises);
    expect(d1.statements[0]?.params[7]).toBeNull();
  });
});

describe("RequestRecorder.finish", () => {
  it("writes one requests row with the outcome fields", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.finish({ status: 200, providerOk: "agnes", elapsedMs: 33 });
    await Promise.all(c.promises);
    expect(d1.statements).toHaveLength(1);
    expect(d1.statements[0]?.sql).toBe(INSERT_REQUEST_SQL);
    expect(d1.statements[0]?.params).toEqual([
      "req-1", "chat", "/v1/chat/completions", "m1", 7, 200, "agnes", 33,
    ]);
  });

  it("writes null provider_ok when absent", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.finish({ status: 502, elapsedMs: 90 });
    await Promise.all(c.promises);
    expect(d1.statements[0]?.params[6]).toBeNull();
  });
});

describe("write failures never break the request", () => {
  it("swallows D1 insert failures with console.warn only", async () => {
    const d1 = makeFakeD1();
    d1.failOnSubstring("INSERT INTO");
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.attempt("agnes", { attempt: 1, result: "ok", elapsedMs: 5 });
    rec.finish({ status: 200, elapsedMs: 8 });
    await expect(Promise.all(c.promises)).resolves.toHaveLength(2);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe("recordUnauthorized", () => {
  it("writes a 401 requests row with derived feature and empty model", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    recordUnauthorized(c.ctx, d1.db, "/v1/read");
    await Promise.all(c.promises);
    expect(d1.statements).toHaveLength(1);
    const params = d1.statements[0]?.params as unknown[];
    expect(typeof params[0]).toBe("string");
    expect(params.slice(1)).toEqual(["read", "/v1/read", "", null, 401, null, null]);
  });
});

describe("featureFromEndpoint", () => {
  it("maps endpoints to features", () => {
    expect(featureFromEndpoint("/v1/chat/completions")).toBe("chat");
    expect(featureFromEndpoint("/v1/embeddings")).toBe("embeddings");
    expect(featureFromEndpoint("/v1/rerank")).toBe("rerank");
    expect(featureFromEndpoint("/v1/read")).toBe("read");
    expect(featureFromEndpoint("/anything-else")).toBe("read");
  });
});
