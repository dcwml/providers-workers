import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailProviderById, runEmail } from "../../src/email/runner";
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
} from "../../src/errors";
import type { Env } from "../../src/env";
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "../helpers";
import { exmail } from "../../src/email/providers/exmail";
import type { PreparedMail } from "../../src/email/types";

// runner 在模块加载时构建 EMAIL_CHAIN，因此 mock 的 provider 用「委托 state」模式。
const state = vi.hoisted(() => ({
  // 最小修正（TS2322）：messageId 改可选，与 EmailSendResult 一致——“omits message_id”用例返回 {}。
  exmailImpl: async (): Promise<{ messageId?: string }> => ({ messageId: "m1" }),
  sendgridImpl: async (): Promise<{ messageId?: string }> => ({ messageId: "m2" }),
}));

vi.mock("../../src/email/providers/exmail", () => ({
  exmail: {
    id: "exmail",
    from: { address: "info@infility.cn" },
    send: (...a: unknown[]) =>
      (state.exmailImpl as (...args: unknown[]) => unknown)(...a),
  },
}));
vi.mock("../../src/email/providers/sendgrid", () => ({
  sendgrid: {
    id: "sendgrid",
    from: { address: "info@infility.cn" },
    send: (...a: unknown[]) =>
      (state.sendgridImpl as (...args: unknown[]) => unknown)(...a),
  },
}));

const env: Env = { AUTH_TOKENS: "" };
const mail: PreparedMail = {
  subject: "Hi",
  bodyKind: "text",
  body: "hello",
  to: [{ address: "a@x.com" }],
  cc: [],
  bcc: [],
};

describe("runEmail", () => {
  beforeEach(() => {
    state.exmailImpl = async () => ({ messageId: "m1" });
    state.sendgridImpl = async () => ({ messageId: "m2" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok with provider body when the first provider succeeds", async () => {
    const outcome = await runEmail(mail, env);
    expect(outcome).toEqual({
      kind: "ok",
      status: 200,
      body: { accepted: true, provider: "exmail", message_id: "m1" },
      providerOk: "exmail",
    });
  });

  it("omits message_id when the provider returns none", async () => {
    state.exmailImpl = async () => ({});
    const outcome = await runEmail(mail, env);
    expect(outcome.body).toEqual({ accepted: true, provider: "exmail" });
  });

  it("falls back to sendgrid after a safe (determined) failure", async () => {
    const calls: string[] = [];
    state.exmailImpl = async () => {
      calls.push("exmail");
      throw new NonRetryableError("EXMAIL_SMTP_PASSWORD is not configured");
    };
    state.sendgridImpl = async () => {
      calls.push("sendgrid");
      return { messageId: "m2" };
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("sendgrid");
    expect(calls).toEqual(["exmail", "sendgrid"]);
  });

  it("does NOT retry a provider even on retryable errors (single attempt)", async () => {
    let exmailCalls = 0;
    state.exmailImpl = async () => {
      exmailCalls++;
      throw new RetryableError("network error: down");
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("sendgrid");
    expect(exmailCalls).toBe(1);
  });

  it("aborts the chain on DeliveryUncertainError (next provider must not run)", async () => {
    const calls: string[] = [];
    state.exmailImpl = async () => {
      calls.push("exmail");
      throw new DeliveryUncertainError("smtp: delivery uncertain after DATA: timeout");
    };
    state.sendgridImpl = async () => {
      calls.push("sendgrid");
      return { messageId: "m2" };
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "exmail", message: "smtp: delivery uncertain after DATA: timeout" },
    ]);
    expect(calls).toEqual(["exmail"]);
  });

  it("returns all-failed with aggregated errors when every provider fails safely", async () => {
    state.exmailImpl = async () => {
      throw new NonRetryableError("exmail dead");
    };
    state.sendgridImpl = async () => {
      throw new RetryableError("sendgrid down");
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "exmail", message: "exmail dead" },
      { provider: "sendgrid", message: "sendgrid down" },
    ]);
  });

  it("runs only the specified provider when only is passed (no fallback)", async () => {
    const calls: string[] = [];
    state.exmailImpl = async () => {
      calls.push("exmail");
      throw new NonRetryableError("exmail dead");
    };
    state.sendgridImpl = async () => {
      calls.push("sendgrid");
      return { messageId: "m2" };
    };
    const outcome = await runEmail(mail, env, exmail);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.errors).toEqual([{ provider: "exmail", message: "exmail dead" }]);
    expect(calls).toEqual(["exmail"]);
  });

  it("resolves providers by id through the real registry", () => {
    expect(getEmailProviderById("exmail")?.id).toBe("exmail");
    expect(getEmailProviderById("sendgrid")?.id).toBe("sendgrid");
    expect(getEmailProviderById("bogus")).toBeUndefined();
  });

  it("logs each attempt with email feature tag", async () => {
    await runEmail(mail, env);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[email] provider=exmail"));
  });

  it("records attempts via recorder and reports providerOk on success", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const recorder = new RequestRecorder(c.ctx, d1.db, {
      requestId: "r9",
      feature: "email",
      endpoint: "/v1/send-email",
      model: "",
      tokenId: 1,
    });
    const outcome = await runEmail(mail, env, undefined, recorder);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("exmail");
    await Promise.all(c.promises);
    const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.params).toEqual(["r9", "email", "exmail", "", 1, "ok", expect.any(Number), null]);
  });
});
