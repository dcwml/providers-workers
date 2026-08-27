import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
} from "../../src/errors";
import { sendgrid } from "../../src/email/providers/sendgrid";
import { exmail } from "../../src/email/providers/exmail";
import type { PreparedMail } from "../../src/email/types";
import type { Env } from "../../src/env";

const mail: PreparedMail = {
  subject: "Hi",
  bodyKind: "html",
  body: "<p>Hello</p>",
  to: [{ name: "A", address: "a@x.com" }, { address: "b@x.com" }],
  cc: [{ address: "c@x.com" }],
  bcc: [{ address: "d@x.com" }],
};
const signal = new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sendgrid email provider", () => {
  const env: Env = { SENDGRID_API_KEY: "sg-test" };

  it("sends the mapped payload and returns the X-Message-Id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 202, headers: { "x-message-id": "abc123" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendgrid.send(mail, env, signal);

    expect(result).toEqual({ messageId: "abc123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sg-test");
    expect(JSON.parse(String(init.body))).toEqual({
      personalizations: [
        {
          to: [{ email: "a@x.com", name: "A" }, { email: "b@x.com" }],
          cc: [{ email: "c@x.com" }],
          bcc: [{ email: "d@x.com" }],
        },
      ],
      from: { email: "info@infility.cn", name: "Infility" },
      subject: "Hi",
      content: [{ type: "text/html", value: "<p>Hello</p>" }],
    });
  });

  it("omits cc/bcc keys when empty and omits message_id when header absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendgrid.send({ ...mail, cc: [], bcc: [] }, env, signal);

    expect(result).toEqual({});
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { personalizations: unknown[] };
    expect(sent.personalizations).toEqual([
      { to: [{ email: "a@x.com", name: "A" }, { email: "b@x.com" }] },
    ]);
  });

  it("maps text bodyKind to text/plain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendgrid.send({ ...mail, bodyKind: "text", body: "plain" }, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { content: { type: string }[] };
    expect(sent.content).toEqual([{ type: "text/plain", value: "plain" }]);
  });

  it("throws NonRetryableError with the standard message when key missing", async () => {
    await expect(sendgrid.send(mail, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(
      "SENDGRID_API_KEY is not configured",
    );
  });

  it("maps a fetch rejection to DeliveryUncertainError (request may have been accepted)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(sendgrid.send(mail, env, signal)).rejects.toBeInstanceOf(DeliveryUncertainError);
  });

  it("maps 4xx to NonRetryableError and 5xx to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    await expect(sendgrid.send(mail, env, signal)).rejects.toBeInstanceOf(NonRetryableError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    await expect(sendgrid.send(mail, env, signal)).rejects.toBeInstanceOf(RetryableError);
  });
});

// exmail 经 vi.mock 隔离 smtp-client（测试不触达真实 socket）
const sendSmtpMailMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/email/smtp-client", () => ({
  sendSmtpMail: sendSmtpMailMock,
}));

describe("exmail email provider", () => {
  it("throws NonRetryableError with the standard message when password missing", async () => {
    await expect(exmail.send(mail, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(
      "EXMAIL_SMTP_PASSWORD is not configured",
    );
  });

  it("delegates to sendSmtpMail with the baked-in transport config", async () => {
    sendSmtpMailMock.mockResolvedValue({ messageId: "<m@infility.cn>" });

    const result = await exmail.send(mail, { EXMAIL_SMTP_PASSWORD: "pw" }, signal);

    expect(result).toEqual({ messageId: "<m@infility.cn>" });
    expect(sendSmtpMailMock).toHaveBeenCalledTimes(1);
    const [options, sig, connectFn] = sendSmtpMailMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
      AbortSignal,
      undefined,
    ];
    expect(options).toMatchObject({
      host: "smtp.exmail.qq.com",
      port: 465,
      secure: "ssl",
      username: "info@infility.cn",
      password: "pw",
      from: { name: "Infility", address: "info@infility.cn" },
      subject: "Hi",
      bodyKind: "html",
      body: "<p>Hello</p>",
    });
    expect(options.to).toBe(mail.to);
    expect(options.cc).toBe(mail.cc);
    expect(options.bcc).toBe(mail.bcc);
    expect(sig).toBe(signal);
    expect(connectFn).toBeUndefined();
  });

  it("propagates errors from the smtp client", async () => {
    sendSmtpMailMock.mockRejectedValue(new NonRetryableError("smtp: AUTH PLAIN rejected: 535 x"));
    await expect(
      exmail.send(mail, { EXMAIL_SMTP_PASSWORD: "pw" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });
});
