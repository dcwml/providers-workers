import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { runChat } from "../../src/chat/runner";
import type { ChatProvider, ChatResponse } from "../../src/chat/types";
import type { Env } from "../../src/env";
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "../helpers";

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

  describe("provider override (only)", () => {
    it("runs only the specified provider, ignoring the model chain", async () => {
      const calls: string[] = [];
      state.chains.m1 = [
        provider("p1", async () => {
          calls.push("p1");
          return { id: "p1" };
        }),
      ];
      const p2 = provider("p2", async () => {
        calls.push("p2");
        return { id: "p2" };
      });
      const outcome = await runChat(req, env, fast, p2);
      expect(outcome).toMatchObject({ kind: "ok", status: 200, body: { id: "p2" } });
      expect(calls).toEqual(["p2"]);
    });

    it("does not fall back when the only provider fails", async () => {
      state.chains.m1 = [provider("p2", async () => ({ id: "p2" }))];
      const p1 = provider("p1", async () => {
        throw new NonRetryableError("p1 refused");
      });
      const outcome = await runChat(req, env, fast, p1);
      expect(outcome.kind).toBe("all-failed");
      expect(outcome.status).toBe(502);
      expect(outcome.errors).toEqual([{ provider: "p1", message: "p1 refused" }]);
    });
  });

  it("records attempts via recorder and reports providerOk on success", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const recorder = new RequestRecorder(c.ctx, d1.db, {
      requestId: "r1", feature: "chat", endpoint: "/v1/chat/completions", model: "m1", tokenId: 1,
    });
    state.chains.m1 = [provider("p1", async () => ({ id: "x" }))];
    const outcome = await runChat(req, env, fast, undefined, recorder);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("p1");
    await Promise.all(c.promises);
    const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.params).toEqual(["r1", "chat", "p1", "m1", 1, "ok", expect.any(Number), null]);
  });

  it("records nothing when no recorder is given (console.log fallback only)", async () => {
    state.chains.m1 = [provider("p1", async () => ({ id: "x" }))];
    const outcome = await runChat(req, env, fast);
    expect(outcome.providerOk).toBe("p1");
  });
});
