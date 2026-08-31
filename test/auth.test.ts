import { describe, expect, it } from "vitest";
import {
  authorize,
  constantTimeEquals,
  normalizeScopes,
  parseScopes,
  scopeAllowed,
  sha256Hex,
  TOKEN_LOOKUP_SQL,
} from "../src/auth";
import { makeFakeD1 } from "./helpers";

function makeRequest(auth?: string): Request {
  const headers = new Headers();
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request("https://gateway.example/v1/read", { headers });
}

describe("authorize", () => {
  it("authorizes a known enabled token and returns its id with unrestricted scopes", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, [{ id: 7, scopes: "" }]);
    const result = await authorize(makeRequest("Bearer sekret"), fake.db);
    expect(result).toEqual({ ok: true, tokenId: 7, scopes: [] });
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.params[0]).toEqual(await sha256Hex("sekret"));
  });

  it("returns the parsed scope list stored on the token row", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, [{ id: 7, scopes: "chat, search" }]);
    expect(await authorize(makeRequest("Bearer sekret"), fake.db)).toEqual({
      ok: true,
      tokenId: 7,
      scopes: ["chat", "search"],
    });
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, [{ id: 1, scopes: "" }]);
    expect(await authorize(makeRequest("bearer sekret"), fake.db)).toEqual({ ok: true, tokenId: 1, scopes: [] });
  });

  it("rejects an unknown or disabled token (no row) as invalid", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, []);
    expect(await authorize(makeRequest("Bearer nope"), fake.db)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a missing authorization header as missing", async () => {
    const fake = makeFakeD1();
    expect(await authorize(makeRequest(), fake.db)).toEqual({ ok: false, reason: "missing" });
    expect(fake.statements).toHaveLength(0);
  });

  it("rejects a non-Bearer scheme as missing", async () => {
    const fake = makeFakeD1();
    expect(await authorize(makeRequest("Basic sekret"), fake.db)).toEqual({ ok: false, reason: "missing" });
  });

  it("maps D1 failures to db-error", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(TOKEN_LOOKUP_SQL);
    expect(await authorize(makeRequest("Bearer sekret"), fake.db)).toEqual({ ok: false, reason: "db-error" });
  });
});

describe("parseScopes", () => {
  it("treats null/undefined/empty as unrestricted (empty list)", () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });

  it("splits on commas, trims, and drops empty segments", () => {
    expect(parseScopes("chat")).toEqual(["chat"]);
    expect(parseScopes("chat,search")).toEqual(["chat", "search"]);
    expect(parseScopes(" chat , search ,")).toEqual(["chat", "search"]);
  });
});

describe("scopeAllowed", () => {
  it("allows everything when the scope list is empty", () => {
    expect(scopeAllowed([], "chat")).toBe(true);
    expect(scopeAllowed([], "email")).toBe(true);
  });

  it("allows only listed scopes otherwise", () => {
    expect(scopeAllowed(["chat"], "chat")).toBe(true);
    expect(scopeAllowed(["chat"], "search")).toBe(false);
  });
});

describe("normalizeScopes", () => {
  it("normalizes case/whitespace and dedupes into a CSV value", () => {
    expect(normalizeScopes(["Chat", " search ", "chat"])).toEqual({ ok: true, value: "chat,search" });
  });

  it("maps an empty array to unrestricted (empty string)", () => {
    expect(normalizeScopes([])).toEqual({ ok: true, value: "" });
  });

  it("rejects non-arrays, non-strings, and unknown scope names", () => {
    expect(normalizeScopes("chat").ok).toBe(false);
    expect(normalizeScopes([1]).ok).toBe(false);
    const unknown = normalizeScopes(["chat", "bogus"]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("unknown scope: bogus");
  });
});

describe("sha256Hex", () => {
  it("produces the known hex digest for a fixed input", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("constantTimeEquals", () => {
  it("matches identical strings and rejects different ones regardless of length", async () => {
    expect(await constantTimeEquals("a", "a")).toBe(true);
    expect(await constantTimeEquals("a", "b")).toBe(false);
    expect(await constantTimeEquals("a", "aa")).toBe(false);
  });
});
