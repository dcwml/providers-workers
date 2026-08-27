import { describe, expect, it } from "vitest";
import {
  sendSmtpMail,
  type SmtpConnectFn,
  type SmtpSendOptions,
  type SmtpSocket,
} from "../../src/email/smtp-client";
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
} from "../../src/errors";

const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const enc = (s: string): string => `=?UTF-8?B?${b64(s)}?=`;

/** 脚本化 fake socket：serverSay 预灌应答（FIFO）；startTls 返回预创建的下一层 socket。 */
class FakeSocket {
  readonly written: string[] = [];
  startTlsCalls = 0;
  private nextTls: FakeSocket | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      this.controller = c;
    },
  });
  readonly writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      this.written.push(new TextDecoder().decode(chunk));
    },
  });
  async startTls(): Promise<SmtpSocket> {
    this.startTlsCalls++;
    return this.tls() as unknown as SmtpSocket;
  }
  close(): Promise<void> {
    // 模拟真实 cloudflare Socket.close() 契约：返回 Promise、对已关闭的流不同步抛错。
    // 若在此同步 throw，实现中 finally 的 `socket?.close().catch(() => {})` 来不及挂上
    // .catch，异常会从 finally 逃逸并替换掉原始返回值/错误（真实 socket 不会这样）。
    try {
      this.controller?.close();
    } catch {
      /* controller 已被 serverEnd() 关闭 —— 幂等关闭，忽略 */
    }
    return Promise.resolve();
  }
  serverSay(text: string): void {
    this.controller?.enqueue(new TextEncoder().encode(text));
  }
  serverEnd(): void {
    this.controller?.close();
  }
  tls(): FakeSocket {
    if (this.nextTls === null) this.nextTls = new FakeSocket();
    return this.nextTls;
  }
}

const signal = new AbortController().signal;

const baseOptions: SmtpSendOptions = {
  host: "smtp.test.example",
  port: 465,
  secure: "ssl",
  username: "user@test.example",
  password: "pass",
  from: { name: "Sender", address: "user@test.example" },
  to: [{ name: "甲", address: "to1@x.com" }, { address: "to2@x.com" }],
  cc: [{ address: "cc1@x.com" }],
  bcc: [{ address: "bcc1@x.com" }],
  subject: "你好 Hello",
  bodyKind: "text",
  body: "Line1\r\nLine2",
};

/** 4 个收件人（to2 + cc1 + bcc1）各回一条 250 ok */
function scriptHappyPath(socket: FakeSocket): void {
  socket.serverSay("220 smtp.test ESMTP ready\r\n");
  socket.serverSay("250-smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
  socket.serverSay("235 ok\r\n"); // AUTH PLAIN
  socket.serverSay("250 ok\r\n"); // MAIL FROM
  socket.serverSay("250 ok\r\n"); // RCPT to1
  socket.serverSay("250 ok\r\n"); // RCPT to2
  socket.serverSay("250 ok\r\n"); // RCPT cc1
  socket.serverSay("250 ok\r\n"); // RCPT bcc1
  socket.serverSay("354 end with .\r\n");
  socket.serverSay("250 queued as 123\r\n");
  socket.serverSay("221 bye\r\n"); // QUIT
}

function connectWith(socket: FakeSocket): SmtpConnectFn {
  return async () => socket as unknown as SmtpSocket;
}

describe("sendSmtpMail happy path (ssl/465)", () => {
  it("completes a full PLAIN session and writes a spec-compliant MIME message", async () => {
    const socket = new FakeSocket();
    scriptHappyPath(socket);
    const result = await sendSmtpMail(baseOptions, signal, connectWith(socket));
    expect(result.messageId).toMatch(/^<.+@test\.example>$/);

    const sent = socket.written.join("");
    expect(sent).toContain("EHLO api.oklapzlj.com\r\n");
    expect(sent).toContain(`AUTH PLAIN ${b64("\u0000user@test.example\u0000pass")}\r\n`);
    expect(sent).toContain("MAIL FROM:<user@test.example>\r\n");
    expect(sent).toContain("RCPT TO:<to1@x.com>\r\n");
    expect(sent).toContain("RCPT TO:<to2@x.com>\r\n");
    expect(sent).toContain("RCPT TO:<cc1@x.com>\r\n");
    expect(sent).toContain("RCPT TO:<bcc1@x.com>\r\n");

    const headerEnd = sent.indexOf("\r\n\r\n");
    const headers = sent.slice(0, headerEnd);
    expect(headers).toContain("From: Sender <user@test.example>");
    expect(headers).toContain(`To: ${enc("甲")} <to1@x.com>, to2@x.com`);
    expect(headers).toContain("Cc: cc1@x.com");
    expect(headers).not.toContain("Bcc:");
    expect(headers).toContain(`Subject: ${enc("你好 Hello")}`);
    expect(headers).toMatch(/Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000/);
    expect(headers).toMatch(/Message-ID: <[0-9a-f-]+@test\.example>/);
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain("Content-Type: text/plain; charset=utf-8");
    expect(headers).toContain("Content-Transfer-Encoding: base64");

    expect(sent.endsWith(".\r\nQUIT\r\n")).toBe(true);
    const m = /\r\n\r\n([\s\S]*)$/.exec(sent);
    const dataSection = m?.[1] ?? "";
    const b64Part = dataSection.slice(0, -".\r\nQUIT\r\n".length);
    const lines = b64Part.split("\r\n");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(76);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(lines.join("")), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe("Line1\r\nLine2");
  });

  it("encodes display names containing RFC specials as encoded-words", async () => {
    const socket = new FakeSocket();
    scriptHappyPath(socket);
    await sendSmtpMail(
      { ...baseOptions, from: { name: "Doe, John", address: "user@test.example" } },
      signal,
      connectWith(socket),
    );

    const all = socket.written.join("");
    const headers = all.slice(0, all.indexOf("\r\n\r\n"));
    // 逗号是地址列表分隔符，含 specials 的 display-name 必须走 encoded-word 而非直出
    expect(headers).toContain(`From: ${enc("Doe, John")} <user@test.example>`);
    expect(headers).not.toContain("From: Doe, John <user@test.example>");
  });

  it("uses text/html content type and folds long base64 bodies", async () => {
    const socket = new FakeSocket();
    scriptHappyPath(socket);
    const longBody = `Hello\r\n${"x".repeat(200)}`;
    await sendSmtpMail({ ...baseOptions, bodyKind: "html", body: longBody }, signal, connectWith(socket));
    const sent = socket.written.join("");
    expect(sent).toContain("Content-Type: text/html; charset=utf-8");
    const m = /\r\n\r\n([\s\S]*)$/.exec(sent);
    const b64Part = (m?.[1] ?? "").slice(0, -".\r\nQUIT\r\n".length);
    expect(b64Part.split("\r\n").length).toBeGreaterThanOrEqual(4);
  });

  it("succeeds even when the server drops the connection after the final 250 (QUIT failure ignored)", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    // MAIL FROM + 4 个 RCPT（to1/to2/cc1/bcc1）共需 5 条 250（原脚本少灌 1 条，
    // 会让 354 被 RCPT bcc1 提前读走；scriptHappyPath 同样是 5 条）
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverSay("250 queued\r\n");
    socket.serverEnd(); // 无 QUIT 应答，连接直接断
    const result = await sendSmtpMail(baseOptions, signal, connectWith(socket));
    expect(result.messageId).toMatch(/^</);
  });
});

describe("sendSmtpMail STARTTLS (starttls/587)", () => {
  it("upgrades to TLS before AUTH and re-issues EHLO", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("220 ready to upgrade\r\n");
    const tls = socket.tls();
    tls.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    tls.serverSay("235 ok\r\n");
    // MAIL FROM + 4 个 RCPT 共需 5 条 250（原脚本少灌 1 条，354 会被 RCPT bcc1 提前读走）
    tls.serverSay("250 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("354 go\r\n");
    tls.serverSay("250 queued\r\n");
    tls.serverSay("221 bye\r\n");

    await sendSmtpMail(
      { ...baseOptions, secure: "starttls", port: 587 },
      signal,
      connectWith(socket),
    );

    expect(socket.startTlsCalls).toBe(1);
    const before = socket.written.join("");
    const after = tls.written.join("");
    expect(before).toContain("EHLO api.oklapzlj.com\r\n");
    expect(before).toContain("STARTTLS\r\n");
    expect(before).not.toContain("AUTH PLAIN"); // 凭证绝不在明文阶段发送
    expect(after).toContain("EHLO api.oklapzlj.com\r\n");
    expect(after).toContain("AUTH PLAIN ");
  });

  it("rejects when the server does not advertise STARTTLS", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    await expect(
      sendSmtpMail({ ...baseOptions, secure: "starttls", port: 587 }, signal, connectWith(socket)),
    ).rejects.toThrow(/does not advertise STARTTLS/);
  });
});

describe("sendSmtpMail AUTH", () => {
  it("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH LOGIN\r\n");
    socket.serverSay("334 VXNlcm5hbWU6\r\n");
    socket.serverSay("334 UGFzc3dvcmQ6\r\n");
    socket.serverSay("235 ok\r\n");
    // MAIL FROM + 4 个 RCPT 共需 5 条 250（原脚本少灌 1 条，354 会被 RCPT bcc1 提前读走）
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverSay("250 queued\r\n");
    socket.serverSay("221 bye\r\n");

    await sendSmtpMail(baseOptions, signal, connectWith(socket));

    const sent = socket.written.join("");
    expect(sent).not.toContain("AUTH PLAIN");
    expect(sent).toContain("AUTH LOGIN\r\n");
    expect(sent).toContain(`${b64("user@test.example")}\r\n`);
    expect(sent).toContain(`${b64("pass")}\r\n`);
  });

  it("rejects with NonRetryableError on a 535 auth failure", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN LOGIN\r\n");
    socket.serverSay("535 authentication failed\r\n");
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      /AUTH PLAIN rejected: 535/,
    );
  });

  it("rejects when no supported AUTH mechanism is advertised", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 SIZE 73400320\r\n");
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      NonRetryableError,
    );
  });
});

describe("sendSmtpMail failure classification", () => {
  it("classifies connect failures as retryable network errors (safe fallback)", async () => {
    const failing: SmtpConnectFn = async () => {
      throw new TypeError("connect failed");
    };
    await expect(sendSmtpMail(baseOptions, signal, failing)).rejects.toBeInstanceOf(RetryableError);
  });

  it("classifies pre-DATA aborts as retryable network errors", async () => {
    const controller = new AbortController();
    controller.abort();
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    await expect(
      sendSmtpMail(baseOptions, controller.signal, connectWith(socket)),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  // 会话中途 abort（生产场景：30s 超时打断进行中的会话）——覆盖 raceAbort 的
  // addEventListener("abort") 分支，而非预先 abort 的 signal.aborted 早退分支。
  it("classifies mid-session timeout abort (pre-DATA) as retryable", async () => {
    const ac = new AbortController();
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    // 此后不再灌应答：AUTH PLAIN 挂起，等 abort 打断（5ms 短定时器自然过期）
    setTimeout(() => ac.abort(), 5);
    await expect(sendSmtpMail(baseOptions, ac.signal, connectWith(socket))).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  it("classifies mid-DATA timeout abort as DeliveryUncertainError", async () => {
    const ac = new AbortController();
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    // MAIL FROM + 4 个 RCPT（to1/to2/cc1/bcc1）共需 5 条 250
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    // 最终应答永不到来：DATA 载荷已发出、结果未知，等 abort 打断
    setTimeout(() => ac.abort(), 5);
    await expect(sendSmtpMail(baseOptions, ac.signal, connectWith(socket))).rejects.toBeInstanceOf(
      DeliveryUncertainError,
    );
  });

  it("rejects with NonRetryableError naming the refused recipient", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("550 no such user\r\n"); // to2 被拒
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      /RCPT TO <to2@x\.com> rejected: 550/,
    );
  });

  it("classifies a post-DATA disconnect as DeliveryUncertainError", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    // MAIL FROM + 4 个 RCPT 共需 5 条 250（原脚本少灌 1 条，354 会被 RCPT bcc1 提前读走）
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverEnd(); // 最终应答永不来
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toBeInstanceOf(
      DeliveryUncertainError,
    );
  });

  it("maps an explicit post-DATA rejection (non-250) to NonRetryableError", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    // MAIL FROM + 4 个 RCPT 共需 5 条 250（原脚本少灌 1 条，550 会被提前消费错位）
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverSay("550 spam detected\r\n");
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      /rejected after DATA: 550/,
    );
  });
});
