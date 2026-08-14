import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { runChat } from "../../src/chat/runner";
import type { ChatProvider, ChatResponse } from "../../src/chat/types";
import type { Env } from "../../src/env";

const state = vi.hoisted(() => ({
  chains: {} as Record<string, ChatProvider[]>,
}));

vi.mock("../../src/chat/chains", () => ({
  getChain: (model: string) => state.chains[model],
}));

const env: Env = { AUTH_TOKENS: "" };
const req = { model: "m1", messages: [{ role: "user" as const, content: "hi" }] };
const fast = { delayMs: 0 }; // 测试中跳过 1s 等待

function provider(id: string, chat: ChatProvider["chat"]): ChatProvider {
  return {
    id,
    capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true },
    chat,
  };
}

describe("runChat", () => {
  beforeEach(() => {
    state.chains = {};
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 outcome for unknown model", async () => {
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "model-not-found", status: 404 });
  });

  it("returns first provider's response on success (pass-through)", async () => {
    const body: ChatResponse = { id: "x", choices: [] };
    state.chains.m1 = [provider("p1", async () => body)];
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200, body });
  });

  it("falls back to next provider after retries are exhausted", async () => {
    let p1Calls = 0;
    state.chains.m1 = [
      provider("p1", async () => {
        p1Calls++;
        throw new RetryableError("down");
      }),
      provider("p2", async () => ({ id: "y" })),
    ];
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200 });
    expect(p1Calls).toBe(3);
  });

  it("moves to next provider without retrying on NonRetryableError", async () => {
    let p1Calls = 0;
    state.chains.m1 = [
      provider("p1", async () => {
        p1Calls++;
        throw new NonRetryableError("bad request");
      }),
      provider("p2", async () => ({ id: "z" })),
    ];
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200 });
    expect(p1Calls).toBe(1);
  });

  it("returns 502 with aggregated errors when whole chain fails", async () => {
    state.chains.m1 = [
      provider("p1", async () => {
        throw new RetryableError("p1 dead");
      }),
      provider("p2", async () => {
        throw new NonRetryableError("p2 refused");
      }),
    ];
    const outcome = await runChat(req, env, fast);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "p1", message: "p1 dead" },
      { provider: "p2", message: "p2 refused" },
    ]);
  });

  it("logs each attempt", async () => {
    state.chains.m1 = [provider("p1", async () => ({ id: "ok" }))];
    await runChat(req, env, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[chat] provider=p1"));
  });
});
