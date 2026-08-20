import { describe, expect, it } from "vitest";
import { handleAdminApi, tokenMask, DELETE_SQL, INSERT_SQL, LIST_SQL, UPDATE_SQL } from "../src/admin";
import { sha256Hex } from "../src/auth";
import type { WorkerEnv } from "../src/env";
import { makeFakeD1 } from "./helpers";

const ADMIN = "admin-secret";

function makeEnv(fake = makeFakeD1(), adminToken = ADMIN): WorkerEnv {
  return { DB: fake.db, ADMIN_TOKEN: adminToken } as WorkerEnv;
}

function req(method: string, path: string, body?: unknown, token = ADMIN): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init = { method, headers, body: JSON.stringify(body) };
  }
  return new Request(`https://gw.example${path}`, init);
}

describe("admin auth", () => {
  it("returns 404 for everything when ADMIN_TOKEN is unset", async () => {
    const fake = makeFakeD1();
    // 注意：不能 makeEnv(fake, undefined)——显式传 undefined 会命中默认参数 ADMIN。
    const env = { DB: fake.db } as WorkerEnv;
    const res = await handleAdminApi(req("GET", "/admin/api/tokens"), env);
    expect(res.status).toBe(404);
    expect(fake.statements).toHaveLength(0);
  });

  it("returns 401 for missing or wrong bearer", async () => {
    const noHeader = new Request("https://gw.example/admin/api/tokens");
    expect((await handleAdminApi(noHeader, makeEnv())).status).toBe(401);
    expect((await handleAdminApi(req("GET", "/admin/api/tokens", undefined, "wrong"), makeEnv())).status).toBe(401);
  });
});

describe("tokenMask", () => {
  it("keeps the full prefix and masks the random part", () => {
    expect(tokenMask("sk_", "abcd1234wxyz")).toBe("sk_abcd...wxyz");
    expect(tokenMask("infility_agent_", "abcd1234wxyz")).toBe("infility_agent_abcd...wxyz");
    expect(tokenMask("", "abcd1234wxyz")).toBe("abcd...wxyz");
  });
});

describe("GET /admin/api/tokens", () => {
  it("lists tokens without ever exposing hash or full token", async () => {
    const fake = makeFakeD1();
    fake.setRows(LIST_SQL, [
      { id: 1, label: "a", token_mask: "sk_abcd...wxyz", enabled: 1, created_at: "2026-08-19T00:00:00.000Z" },
    ]);
    const res = await handleAdminApi(req("GET", "/admin/api/tokens"), makeEnv(fake));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tokens: unknown[] };
    expect(data.tokens).toHaveLength(1);
    const body = JSON.stringify(data);
    expect(body).not.toContain("token_hash");
    expect(body).not.toContain("abcd1234wxyz");
  });
});

describe("POST /admin/api/tokens", () => {
  it("creates a token, stores hash+mask, returns full token exactly once", async () => {
    const fake = makeFakeD1();
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abcd1234wxyz", label: "test" }),
      makeEnv(fake),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: number; token: string; token_mask: string };
    expect(data).toEqual({ id: 1, token: "sk_abcd1234wxyz", token_mask: "sk_abcd...wxyz" });
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.params).toEqual([
      await sha256Hex("sk_abcd1234wxyz"),
      "sk_",
      "sk_abcd...wxyz",
      "test",
    ]);
  });

  it("rejects random shorter than 8 chars with 400", async () => {
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abc" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: "random part must be at least 8 characters", code: "random_too_short" },
    });
  });

  it("rejects empty prefix+random with 400", async () => {
    const res = await handleAdminApi(req("POST", "/admin/api/tokens", {}), makeEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: "prefix and random cannot both be empty", code: "empty_token" },
    });
  });

  it("maps UNIQUE violations to 409", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(INSERT_SQL, "UNIQUE constraint failed: tokens.token_hash");
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abcd1234wxyz" }),
      makeEnv(fake),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { message: "token already exists", code: "duplicate_token" },
    });
  });

  it("maps other D1 failures to 500", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(INSERT_SQL);
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abcd1234wxyz" }),
      makeEnv(fake),
    );
    expect(res.status).toBe(500);
  });
});

describe("PATCH /admin/api/tokens/:id", () => {
  it("toggles enabled", async () => {
    const fake = makeFakeD1();
    const res = await handleAdminApi(req("PATCH", "/admin/api/tokens/5", { enabled: false }), makeEnv(fake));
    expect(res.status).toBe(200);
    expect(fake.statements[0]?.sql).toBe(UPDATE_SQL);
    expect(fake.statements[0]?.params).toEqual([0, 5]);
  });

  it("rejects non-boolean enabled with 400", async () => {
    const res = await handleAdminApi(req("PATCH", "/admin/api/tokens/5", { enabled: "yes" }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the id does not exist (changes=0)", async () => {
    const fake = makeFakeD1();
    fake.setRunMeta(UPDATE_SQL, { changes: 0, last_row_id: 0 });
    const res = await handleAdminApi(req("PATCH", "/admin/api/tokens/99", { enabled: true }), makeEnv(fake));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/api/tokens/:id", () => {
  it("deletes and returns ok", async () => {
    const fake = makeFakeD1();
    const res = await handleAdminApi(req("DELETE", "/admin/api/tokens/5"), makeEnv(fake));
    expect(res.status).toBe(200);
    expect(fake.statements[0]?.params).toEqual([5]);
  });

  it("returns 404 when the id does not exist", async () => {
    const fake = makeFakeD1();
    fake.setRunMeta(DELETE_SQL, { changes: 0, last_row_id: 0 });
    const res = await handleAdminApi(req("DELETE", "/admin/api/tokens/99"), makeEnv(fake));
    expect(res.status).toBe(404);
  });
});

describe("unknown admin paths", () => {
  it("returns 404", async () => {
    const res = await handleAdminApi(req("GET", "/admin/api/nope"), makeEnv());
    expect(res.status).toBe(404);
  });
});
