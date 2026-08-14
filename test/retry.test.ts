import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../src/errors";
import { withRetry, type AttemptInfo } from "../src/retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first successful result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries RetryableError up to 3 attempts then throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("boom"));
    const p = withRetry(fn, { delayMs: 1000 });
    p.catch(() => {}); // 挂住 rejection，避免 unhandled 警告
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("waits delayMs between attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("boom"));
    const p = withRetry(fn, { delayMs: 1000 });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("succeeds after transient failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("1"))
      .mockRejectedValueOnce(new RetryableError("2"))
      .mockResolvedValue("done");
    const p = withRetry(fn, { delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry NonRetryableError", async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError("bad"));
    await expect(withRetry(fn)).rejects.toThrow("bad");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("x"));
    const p = withRetry(fn, { maxAttempts: 5, delayMs: 10 });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(40);
    await expect(p).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("reports per-attempt results via onAttempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("x"))
      .mockResolvedValue("ok");
    const seen: AttemptInfo[] = [];
    const p = withRetry(fn, { delayMs: 1000, onAttempt: (info) => seen.push(info) });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(seen.map((s) => s.result)).toEqual(["retry", "ok"]);
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen[0]?.error).toBeInstanceOf(RetryableError);
    expect(seen[1]?.error).toBeUndefined();
  });
});
