import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOutcome } from "../src/chat/runner";
import type { ReadOutcome } from "../src/read/runner";
import type { Env } from "../src/env";

const state = vi.hoisted(() => ({
  chatOutcome: undefined as unknown as ChatOutcome,
  readOutcome: undefined as unknown as ReadOutcome,
}));

vi.mock("../src/chat/runner", () => ({
  runChat: async () => state.chatOutcome,
}));
vi.mock("../src/read/runner", () => ({
  runRead: async () => state.readOutcome,
}));

import handler from "../src/index";

const env: Env = { AUTH_TOKENS: "sekret" };

function post(path: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers.authorization = token === undefined ? "Bearer sekret" : `Bearer ${token}`;
  return new Request(`https://gw.example${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.chatOutcome = { kind: "ok", status: 200, body: { id: "default" } };
  state.readOutcome = { kind: "ok", status: 200, markdown: "# default" };
});

describe("auth", () => {
  it("rejects missing token with 401", async () => {
    const req = new Request("https://gw.example/v1/read", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects wrong token with 401 even for invalid body (auth runs first)", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "not json",
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(401);
  });
});

describe("routing", () => {
  it("returns 404 for unknown path", async () => {
    const res = await handler.fetch(post("/nope", {}), env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET on known path", async () => {
    const req = new Request("https://gw.example/v1/read", {
      headers: { authorization: "Bearer sekret" },
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(404);
  });
});

describe("chat endpoint", () => {
  it("passes through the runner body with 200", async () => {
    state.chatOutcome = { kind: "ok", status: 200, body: { id: "abc", choices: [] } };
    const res = await handler.fetch(
      post("/v1/chat/completions", { model: "sample-chat", messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ id: "abc", choices: [] });
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "not json",
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("rejects a valid JSON null body with 400", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "null",
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("rejects missing model with 400", async () => {
    const res = await handler.fetch(
      post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects stream=true with 400", async () => {
    const res = await handler.fetch(
      post("/v1/chat/completions", {
        model: "sample-chat",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("maps model-not-found outcome to 404", async () => {
    state.chatOutcome = { kind: "model-not-found", status: 404 };
    const res = await handler.fetch(
      post("/v1/chat/completions", { model: "nope", messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("maps all-failed outcome to 502", async () => {
    state.chatOutcome = {
      kind: "all-failed",
      status: 502,
      errors: [{ provider: "p1", message: "dead" }],
    };
    const res = await handler.fetch(
      post("/v1/chat/completions", { model: "sample-chat", messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { provider_errors: unknown[] } };
    expect(body.error.provider_errors).toEqual([{ provider: "p1", message: "dead" }]);
  });
});

describe("read endpoint", () => {
  it("returns markdown with text/markdown content type", async () => {
    state.readOutcome = { kind: "ok", status: 200, markdown: "# hi" };
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# hi");
  });

  it("rejects non-http url with 400", async () => {
    const res = await handler.fetch(post("/v1/read", { url: "ftp://example.com" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects missing url with 400", async () => {
    const res = await handler.fetch(post("/v1/read", {}), env);
    expect(res.status).toBe(400);
  });

  it("rejects a valid JSON null body with 400", async () => {
    const res = await handler.fetch(post("/v1/read", null), env);
    expect(res.status).toBe(400);
  });

  it("maps all-failed outcome to 502", async () => {
    state.readOutcome = {
      kind: "all-failed",
      status: 502,
      errors: [{ provider: "jina", message: "dead" }],
    };
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), env);
    expect(res.status).toBe(502);
  });
});
