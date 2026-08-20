import { describe, expect, it } from "vitest";
import { authorize, constantTimeEquals, sha256Hex, TOKEN_LOOKUP_SQL } from "../src/auth";
import { makeFakeD1 } from "./helpers";

function makeRequest(auth?: string): Request {
  const headers = new Headers();
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request("https://gateway.example/v1/read", { headers });
}

describe("authorize", () => {
  it("authorizes a known enabled token and returns its id", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, [{ id: 7 }]);
    const result = await authorize(makeRequest("Bearer sekret"), fake.db);
    expect(result).toEqual({ ok: true, tokenId: 7 });
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.params[0]).toEqual(await sha256Hex("sekret"));
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, [{ id: 1 }]);
    expect(await authorize(makeRequest("bearer sekret"), fake.db)).toEqual({ ok: true, tokenId: 1 });
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
