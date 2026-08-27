import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOutcome } from "../src/chat/runner";
import type { EmailOutcome } from "../src/email/runner";
import type { EmbeddingsOutcome } from "../src/embeddings/runner";
import type { ReadOutcome } from "../src/read/runner";
import type { RerankOutcome } from "../src/rerank/runner";
import { TOKEN_LOOKUP_SQL } from "../src/auth";
import type { WorkerEnv } from "../src/env";
import { INSERT_REQUEST_SQL } from "../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "./helpers";

const state = vi.hoisted(() => ({
  chatOutcome: undefined as unknown as ChatOutcome,
  readOutcome: undefined as unknown as ReadOutcome,
  embeddingsOutcome: undefined as unknown as EmbeddingsOutcome,
  rerankOutcome: undefined as unknown as RerankOutcome,
  chatOnly: undefined as unknown,
  readOnly: undefined as unknown,
  embeddingsProvider: undefined as unknown,
  rerankProvider: undefined as unknown,
  emailOutcome: undefined as unknown as EmailOutcome,
  emailOnly: undefined as unknown,
  emailMail: undefined as unknown,
}));

vi.mock("../src/chat/runner", () => ({
  runChat: async (_req: unknown, _env: unknown, _retry: unknown, only: unknown) => {
    state.chatOnly = only;
    return state.chatOutcome;
  },
}));
vi.mock("../src/read/runner", () => ({
  runRead: async (_url: unknown, _env: unknown, _retry: unknown, only: unknown) => {
    state.readOnly = only;
    return state.readOutcome;
  },
  getReaderProviderById: (id: string) =>
    id === "jina" || id === "tavily" || id === "firecrawl" ? { id } : undefined,
  READER_PROVIDER_IDS: ["jina", "tavily", "firecrawl"],
}));
vi.mock("../src/embeddings/runner", () => ({
  runEmbeddings: async (_req: unknown, _env: unknown, provider: unknown) => {
    state.embeddingsProvider = provider;
    return state.embeddingsOutcome;
  },
}));
vi.mock("../src/rerank/runner", () => ({
  runRerank: async (_req: unknown, _env: unknown, provider: unknown) => {
    state.rerankProvider = provider;
    return state.rerankOutcome;
  },
}));
vi.mock("../src/email/runner", () => ({
  runEmail: async (mail: unknown, _env: unknown, only: unknown) => {
    state.emailMail = mail;
    state.emailOnly = only;
    return state.emailOutcome;
  },
  getEmailProviderById: (id: string) =>
    id === "exmail" || id === "sendgrid" ? { id } : undefined,
  EMAIL_PROVIDER_IDS: ["exmail", "sendgrid"],
}));

import handler from "../src/index";

function makeEnv(rows: Record<string, unknown>[] = [{ id: 7 }]): WorkerEnv {
  const fake = makeFakeD1();
  fake.setRows(TOKEN_LOOKUP_SQL, rows);
  return { DB: fake.db } as WorkerEnv;
}

const env = makeEnv();

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
  state.chatOutcome = { kind: "ok", status: 200, body: { id: "default" }, providerOk: "p-default" };
  state.readOutcome = { kind: "ok", status: 200, markdown: "# default", providerOk: "p-default" };
  state.embeddingsOutcome = { kind: "ok", status: 200, body: { data: [] }, providerOk: "p-default" };
  state.rerankOutcome = { kind: "ok", status: 200, body: { results: [] }, providerOk: "p-default" };
  state.chatOnly = undefined;
  state.readOnly = undefined;
  state.embeddingsProvider = undefined;
  state.rerankProvider = undefined;
  state.emailOutcome = { kind: "ok", status: 200, body: { accepted: true, provider: "exmail" }, providerOk: "exmail" };
  state.emailOnly = undefined;
  state.emailMail = undefined;
});

describe("auth", () => {
  it("rejects missing token with 401", async () => {
    const req = new Request("https://gw.example/v1/read", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(401);
  });

  it("rejects wrong token with 401 even for invalid body (auth runs first)", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "not json",
    });
    const res = await handler.fetch(req, makeEnv([]), makeFakeCtx().ctx);
    expect(res.status).toBe(401);
  });

  it("returns 500 when the token store (D1) fails", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(TOKEN_LOOKUP_SQL);
    const envDown: WorkerEnv = { DB: fake.db } as WorkerEnv;
    const res = await handler.fetch(
      post("/v1/read", { url: "https://example.com" }),
      envDown,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { message: "auth store unavailable", type: "server_error", code: "auth_store_error" },
    });
  });
});

describe("routing", () => {
  it("returns 404 for unknown path", async () => {
    const res = await handler.fetch(post("/nope", {}), env, makeFakeCtx().ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET on known path", async () => {
    const req = new Request("https://gw.example/v1/read", {
      headers: { authorization: "Bearer sekret" },
    });
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(404);
  });
});

describe("chat endpoint", () => {
  it("passes through the runner body with 200", async () => {
    state.chatOutcome = { kind: "ok", status: 200, body: { id: "abc", choices: [] } };
    const res = await handler.fetch(
      post("/v1/chat/completions", { model: "sample-chat", messages: [{ role: "user", content: "hi" }] }),
      env,
      makeFakeCtx().ctx,
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
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a valid JSON null body with 400", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "null",
    });
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects missing model with 400", async () => {
    const res = await handler.fetch(
      post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }),
      env,
      makeFakeCtx().ctx,
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
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
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
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { provider_errors: unknown[] } };
    expect(body.error.provider_errors).toEqual([{ provider: "p1", message: "dead" }]);
  });
});

describe("read endpoint", () => {
  it("returns markdown with text/markdown content type", async () => {
    state.readOutcome = { kind: "ok", status: 200, markdown: "# hi" };
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), env, makeFakeCtx().ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# hi");
  });

  it("rejects non-http url with 400", async () => {
    const res = await handler.fetch(post("/v1/read", { url: "ftp://example.com" }), env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects missing url with 400", async () => {
    const res = await handler.fetch(post("/v1/read", {}), env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a valid JSON null body with 400", async () => {
    const res = await handler.fetch(post("/v1/read", null), env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("maps all-failed outcome to 502", async () => {
    state.readOutcome = {
      kind: "all-failed",
      status: 502,
      errors: [{ provider: "jina", message: "dead" }],
    };
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), env, makeFakeCtx().ctx);
    expect(res.status).toBe(502);
  });
});

describe("embeddings endpoint", () => {
  const validBody = { model: "BAAI/bge-m3", input: "hi" };

  it("passes through the runner body with 200", async () => {
    state.embeddingsOutcome = {
      kind: "ok",
      status: 200,
      body: { object: "list", data: [{ embedding: [0.1] }] },
    };
    const res = await handler.fetch(post("/v1/embeddings", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ object: "list", data: [{ embedding: [0.1] }] });
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("https://gw.example/v1/embeddings", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "not json",
    });
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a valid JSON null body with 400", async () => {
    const res = await handler.fetch(post("/v1/embeddings", null), env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects missing model with 400", async () => {
    const res = await handler.fetch(post("/v1/embeddings", { input: "hi" }), env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects missing input with 400", async () => {
    const res = await handler.fetch(post("/v1/embeddings", { model: "BAAI/bge-m3" }), env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects empty-string and empty-array input with 400", async () => {
    const res1 = await handler.fetch(
      post("/v1/embeddings", { model: "BAAI/bge-m3", input: "" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res1.status).toBe(400);
    const res2 = await handler.fetch(
      post("/v1/embeddings", { model: "BAAI/bge-m3", input: [] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res2.status).toBe(400);
  });

  it("rejects unknown model with 400 model_not_found (no fallback)", async () => {
    const res = await handler.fetch(
      post("/v1/embeddings", { model: "nope", input: "hi" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("model not found: nope");
    expect(body.error.message).toContain("BAAI/bge-m3");
  });

  it("maps failed outcome to 502 with provider_errors", async () => {
    state.embeddingsOutcome = {
      kind: "failed",
      status: 502,
      errors: [{ provider: "siliconflow", message: "dead" }],
    };
    const res = await handler.fetch(post("/v1/embeddings", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; provider_errors: unknown[] };
    };
    expect(body.error.code).toBe("provider_failed");
    expect(body.error.provider_errors).toEqual([{ provider: "siliconflow", message: "dead" }]);
  });
});

describe("rerank endpoint", () => {
  const validBody = {
    model: "BAAI/bge-reranker-v2-m3",
    query: "What is deep learning?",
    documents: ["Deep learning is a branch of machine learning.", "It will rain tomorrow."],
  };

  it("passes through the runner body with 200", async () => {
    state.rerankOutcome = {
      kind: "ok",
      status: 200,
      body: { id: "x", results: [{ index: 0, relevance_score: 0.9 }] },
    };
    const res = await handler.fetch(post("/v1/rerank", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      id: "x",
      results: [{ index: 0, relevance_score: 0.9 }],
    });
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("https://gw.example/v1/rerank", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "not json",
    });
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a valid JSON null body with 400", async () => {
    const res = await handler.fetch(post("/v1/rerank", null), env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects missing model with 400", async () => {
    const res = await handler.fetch(
      post("/v1/rerank", { query: "q", documents: ["a"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing or empty query/documents with 400", async () => {
    const noQuery = await handler.fetch(
      post("/v1/rerank", { model: "BAAI/bge-reranker-v2-m3", documents: ["a"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(noQuery.status).toBe(400);
    const emptyQuery = await handler.fetch(
      post("/v1/rerank", { model: "BAAI/bge-reranker-v2-m3", query: "", documents: ["a"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(emptyQuery.status).toBe(400);
    const noDocs = await handler.fetch(
      post("/v1/rerank", { model: "BAAI/bge-reranker-v2-m3", query: "q" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(noDocs.status).toBe(400);
    const emptyDocs = await handler.fetch(
      post("/v1/rerank", { model: "BAAI/bge-reranker-v2-m3", query: "q", documents: [] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(emptyDocs.status).toBe(400);
  });

  it("rejects unknown model with 400 model_not_found (no fallback)", async () => {
    const res = await handler.fetch(
      post("/v1/rerank", { model: "nope", query: "q", documents: ["a"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("model not found: nope");
    expect(body.error.message).toContain("BAAI/bge-reranker-v2-m3");
  });

  it("maps failed outcome to 502 with provider_errors", async () => {
    state.rerankOutcome = {
      kind: "failed",
      status: 502,
      errors: [{ provider: "siliconflow", message: "dead" }],
    };
    const res = await handler.fetch(post("/v1/rerank", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; provider_errors: unknown[] };
    };
    expect(body.error.code).toBe("provider_failed");
    expect(body.error.provider_errors).toEqual([{ provider: "siliconflow", message: "dead" }]);
  });
});

describe("send-email endpoint", () => {
  const validBody = {
    subject: "Hello",
    html: "<p>Hi</p>",
    to: ["a@x.com"],
  };

  it("passes through the runner body with 200", async () => {
    state.emailOutcome = {
      kind: "ok",
      status: 200,
      body: { accepted: true, provider: "exmail", message_id: "m1" },
      providerOk: "exmail",
    };
    const res = await handler.fetch(post("/v1/send-email", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, provider: "exmail", message_id: "m1" });
  });

  it("prefers html when both text and html are provided", async () => {
    await handler.fetch(
      post("/v1/send-email", { ...validBody, text: "plain fallback" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(state.emailMail).toMatchObject({ bodyKind: "html", body: "<p>Hi</p>" });
  });

  it("uses text when html is absent", async () => {
    await handler.fetch(
      post("/v1/send-email", { subject: "s", text: "plain only", to: ["a@x.com"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(state.emailMail).toMatchObject({ bodyKind: "text", body: "plain only" });
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("https://gw.example/v1/send-email", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "not json",
    });
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a null body and missing subject with 400", async () => {
    const res1 = await handler.fetch(post("/v1/send-email", null), env, makeFakeCtx().ctx);
    expect(res1.status).toBe(400);
    const res2 = await handler.fetch(
      post("/v1/send-email", { html: "x", to: ["a@x.com"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("missing_subject");
  });

  it("rejects control characters in subject with invalid_subject", async () => {
    const res = await handler.fetch(
      post("/v1/send-email", { ...validBody, subject: "bad\u0007subject" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_subject");
  });

  it("rejects missing body with missing_body", async () => {
    const res = await handler.fetch(
      post("/v1/send-email", { subject: "s", to: ["a@x.com"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_body");
  });

  it("rejects invalid to types with invalid_recipients", async () => {
    const res1 = await handler.fetch(
      post("/v1/send-email", { ...validBody, to: [] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res1.status).toBe(400);
    const res2 = await handler.fetch(
      post("/v1/send-email", { ...validBody, to: 42 }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("invalid_recipients");
  });

  it("rejects a malformed address with a positioned message", async () => {
    const res = await handler.fetch(
      post("/v1/send-email", { ...validBody, cc: ["ok@x.com", "not-an-address"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_recipients");
    expect(body.error.message).toContain('cc[1]: invalid address "not-an-address"');
  });

  it("accepts a single string recipient and dedupes across groups", async () => {
    await handler.fetch(
      post("/v1/send-email", {
        subject: "s",
        html: "x",
        to: "A@X.com",
        cc: ["a@x.com", "c@x.com"],
        bcc: ["c@x.com"],
      }),
      env,
      makeFakeCtx().ctx,
    );
    expect(state.emailMail).toMatchObject({
      to: [{ address: "A@X.com" }],
      cc: [{ address: "c@x.com" }],
      bcc: [],
    });
  });

  it("maps uncertain outcome to 502 delivery_uncertain", async () => {
    state.emailOutcome = {
      kind: "uncertain",
      status: 502,
      errors: [{ provider: "exmail", message: "uncertain" }],
    };
    const res = await handler.fetch(post("/v1/send-email", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; provider_errors: unknown[] } };
    expect(body.error.code).toBe("delivery_uncertain");
    expect(body.error.provider_errors).toEqual([{ provider: "exmail", message: "uncertain" }]);
  });

  it("maps all-failed outcome to 502 all_providers_failed", async () => {
    state.emailOutcome = {
      kind: "all-failed",
      status: 502,
      errors: [{ provider: "exmail", message: "dead" }],
    };
    const res = await handler.fetch(post("/v1/send-email", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_providers_failed");
  });

  it("resolves ?provider=sendgrid and rejects unknown providers", async () => {
    const res = await handler.fetch(
      post("/v1/send-email?provider=sendgrid", validBody),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect((state.emailOnly as { id: string }).id).toBe("sendgrid");

    const res2 = await handler.fetch(
      post("/v1/send-email?provider=bogus", validBody),
      env,
      makeFakeCtx().ctx,
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: { code: string; message: string } };
    expect(body2.error.code).toBe("unknown_provider");
    expect(body2.error.message).toContain("exmail, sendgrid");
  });

  it("records one requests row with feature email", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/send-email", validBody), envReq, c.ctx);
    expect(res.status).toBe(200);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[1]).toBe("email");
    expect(row?.params[3]).toBe("");
  });
});

describe("provider override (?provider=)", () => {
  it("read: resolves provider and passes it to runRead", async () => {
    const res = await handler.fetch(
      post("/v1/read?provider=firecrawl", { url: "https://example.com" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect(state.readOnly).toEqual({ id: "firecrawl" });
  });

  it("read: no provider param leaves override undefined", async () => {
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), env, makeFakeCtx().ctx);
    expect(res.status).toBe(200);
    expect(state.readOnly).toBeUndefined();
  });

  it("read: rejects unknown provider with 400", async () => {
    const res = await handler.fetch(
      post("/v1/read?provider=bogus", { url: "https://example.com" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("unknown provider: bogus");
    expect(body.error.message).toContain("jina, tavily, firecrawl");
  });

  it("chat: resolves provider and passes it to runChat", async () => {
    const res = await handler.fetch(
      post("/v1/chat/completions?provider=gptsapi", {
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
      }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect((state.chatOnly as { id: string }).id).toBe("gptsapi");
  });

  it("chat: rejects unknown provider with 400 and unknown_provider code", async () => {
    const res = await handler.fetch(
      post("/v1/chat/completions?provider=bogus", {
        model: "sample-chat",
        messages: [{ role: "user", content: "hi" }],
      }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unknown_provider");
    expect(body.error.message).toContain("unknown provider: bogus");
  });

  it("embeddings: resolves provider and passes it to runEmbeddings", async () => {
    const res = await handler.fetch(
      post("/v1/embeddings?provider=siliconflow", { model: "BAAI/bge-m3", input: "hi" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect((state.embeddingsProvider as { id: string }).id).toBe("siliconflow");
  });

  it("embeddings: rejects unknown provider with 400 and unknown_provider code", async () => {
    const res = await handler.fetch(
      post("/v1/embeddings?provider=bogus", { model: "BAAI/bge-m3", input: "hi" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unknown_provider");
    expect(body.error.message).toContain("unknown provider: bogus");
    expect(body.error.message).toContain("siliconflow");
  });

  it("rerank: resolves provider and passes it to runRerank", async () => {
    const res = await handler.fetch(
      post("/v1/rerank?provider=siliconflow", {
        model: "BAAI/bge-reranker-v2-m3",
        query: "q",
        documents: ["a"],
      }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect((state.rerankProvider as { id: string }).id).toBe("siliconflow");
  });

  it("rerank: rejects unknown provider with 400 and unknown_provider code", async () => {
    const res = await handler.fetch(
      post("/v1/rerank?provider=bogus", {
        model: "BAAI/bge-reranker-v2-m3",
        query: "q",
        documents: ["a"],
      }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unknown_provider");
    expect(body.error.message).toContain("unknown provider: bogus");
    expect(body.error.message).toContain("siliconflow");
  });
});

describe("telemetry", () => {
  it("records one requests row per authorized call with final status and providerOk", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), envReq, c.ctx);
    expect(res.status).toBe(200);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[1]).toBe("read");
    expect(row?.params[3]).toBe("");
    expect(row?.params[4]).toBe(3);
    expect(row?.params[5]).toBe(200);
    expect(row?.params[6]).toBe("p-default");
    expect(typeof row?.params[7]).toBe("number");
  });

  it("records model for chat after body validation", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    await handler.fetch(
      post("/v1/chat/completions", { model: "m1", messages: [{ role: "user", content: "hi" }] }),
      envReq,
      c.ctx,
    );
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[2]).toBe("/v1/chat/completions");
    expect(row?.params[3]).toBe("m1");
  });

  it("records a 401 row for unauthorized calls (token_id NULL, no attempts)", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }, "wrong"), envReq, c.ctx);
    expect(res.status).toBe(401);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[4]).toBeNull();
    expect(row?.params[5]).toBe(401);
  });

  it("records a requests row for validation 400s too", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/read", { url: "not-a-url" }), envReq, c.ctx);
    expect(res.status).toBe(400);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[5]).toBe(400);
  });
});

describe("admin page routing", () => {
  it("serves the static shell for GET /admin without auth", async () => {
    const res = await handler.fetch(
      new Request("https://gw.example/admin"),
      makeEnv(),
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("admin_token"); // 登录逻辑存在
    expect(html).toContain("noindex"); // 不被搜索引擎收录
    expect(html).not.toContain("sk-"); // 壳内不含任何数据/密钥
  });

  it("routes /admin/api/* through handleAdminApi (401 without bearer)", async () => {
    const envAdmin = makeEnv();
    envAdmin.ADMIN_TOKEN = "admin-secret";
    const res = await handler.fetch(
      new Request("https://gw.example/admin/api/tokens"),
      envAdmin,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for GET on unknown admin path", async () => {
    const res = await handler.fetch(
      new Request("https://gw.example/admin/nope"),
      makeEnv(),
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(404);
  });
});
