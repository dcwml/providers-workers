import { describe, expect, it } from "vitest";
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../src/errors";

describe("classifyHttpStatus", () => {
  it("treats 429 as retryable", () => {
    expect(classifyHttpStatus(429, "rate limited")).toBeInstanceOf(RetryableError);
  });

  it("treats 5xx as retryable", () => {
    expect(classifyHttpStatus(500, "boom")).toBeInstanceOf(RetryableError);
    expect(classifyHttpStatus(503, "unavailable")).toBeInstanceOf(RetryableError);
  });

  it("treats other 4xx as non-retryable", () => {
    expect(classifyHttpStatus(400, "bad request")).toBeInstanceOf(NonRetryableError);
    expect(classifyHttpStatus(401, "unauthorized")).toBeInstanceOf(NonRetryableError);
    expect(classifyHttpStatus(403, "forbidden")).toBeInstanceOf(NonRetryableError);
  });

  it("includes status and truncated body snippet in message", () => {
    const err = classifyHttpStatus(500, "x".repeat(500));
    expect(err.message).toContain("500");
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("classifyNetworkError", () => {
  it("wraps an Error into RetryableError keeping its message", () => {
    const err = classifyNetworkError(new TypeError("fetch failed"));
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.message).toContain("fetch failed");
  });

  it("wraps non-Error values", () => {
    expect(classifyNetworkError("weird").message).toContain("weird");
  });
});

describe("DeliveryUncertainError", () => {
  it("is a distinct Error subclass carrying its name and cause", () => {
    const cause = new TypeError("socket died");
    const err = new DeliveryUncertainError("smtp: uncertain", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DeliveryUncertainError");
    expect(err.message).toBe("smtp: uncertain");
    expect(err.cause).toBe(cause);
  });
});
