import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth";

function makeRequest(auth?: string): Request {
  const headers = new Headers();
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request("https://gateway.example/v1/read", { headers });
}

describe("isAuthorized", () => {
  it("accepts a valid token", async () => {
    expect(await isAuthorized(makeRequest("Bearer secret-1"), "secret-1")).toBe(true);
  });

  it("accepts one of multiple comma-separated tokens (with padding spaces)", async () => {
    expect(await isAuthorized(makeRequest("Bearer b"), "a, b ,c")).toBe(true);
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    expect(await isAuthorized(makeRequest("bearer secret-1"), "secret-1")).toBe(true);
  });

  it("rejects a wrong token", async () => {
    expect(await isAuthorized(makeRequest("Bearer nope"), "secret-1")).toBe(false);
  });

  it("rejects a missing authorization header", async () => {
    expect(await isAuthorized(makeRequest(), "secret-1")).toBe(false);
  });

  it("rejects a non-Bearer scheme", async () => {
    expect(await isAuthorized(makeRequest("Basic secret-1"), "secret-1")).toBe(false);
  });

  it("rejects when token list is empty", async () => {
    expect(await isAuthorized(makeRequest("Bearer x"), " , ")).toBe(false);
  });

  it("rejects when token list is an empty string (unset secret)", async () => {
    expect(await isAuthorized(makeRequest("Bearer secret-1"), "")).toBe(false);
  });

  it("rejects when token list is undefined (unset secret at runtime)", async () => {
    expect(await isAuthorized(makeRequest("Bearer secret-1"), undefined as unknown as string)).toBe(false);
  });
});
