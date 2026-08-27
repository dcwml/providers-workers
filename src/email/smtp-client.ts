import { DeliveryUncertainError, NonRetryableError, classifyNetworkError } from "../errors";
import type { ParsedAddress } from "./types";

/**
 * 会话所需的 socket 最小面（cloudflare:sockets 的 Socket 结构性兼容；测试注入 FakeSocket）。
 * 这是 SMTP 协议传输库而非供应商适配层（spec 3.1 的明确豁免）。
 */
export interface SmtpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  startTls(): Promise<SmtpSocket>;
  close(): Promise<void>;
}

export type SmtpConnectFn = (
  host: string,
  port: number,
  options: { secureTransport: "on" | "starttls" },
) => Promise<SmtpSocket>;

/** 默认连接器：动态 import（cloudflare:sockets 仅 Worker 运行时存在，测试从不触达）。 */
export const defaultConnect: SmtpConnectFn = async (host, port, options) => {
  const { connect } = await import("cloudflare:sockets");
  // allowHalfOpen 显式传 false（即 cloudflare connect() 的文档默认值，运行时行为不变）：
  // 本版 @cloudflare/workers-types 把 SocketOptions.allowHalfOpen 声明为必填。
  const socket = connect(
    { hostname: host, port },
    { secureTransport: options.secureTransport, allowHalfOpen: false },
  );
  await socket.opened;
  return socket as unknown as SmtpSocket;
};

export interface SmtpSendOptions {
  host: string;
  port: number;
  secure: "ssl" | "starttls";
  username: string;
  password: string;
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  subject: string;
  bodyKind: "text" | "html";
  body: string;
}

export interface SmtpSendResult {
  messageId: string;
}

/** EHLO 自报域名（网关生产域名） */
const EHLO_NAME = "api.oklapzlj.com";

interface SmtpReply {
  code: number;
  text: string;
  lines: string[];
}

class SmtpSession {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  static fromSocket(socket: SmtpSocket): SmtpSession {
    return new SmtpSession(socket.readable.getReader(), socket.writable.getWriter());
  }

  async writeLine(line: string): Promise<void> {
    await this.writer.write(this.encoder.encode(line + "\r\n"));
  }

  /**
   * 写 DATA 载荷，应用 SMTP dot-stuffing（行首 . 加倍）。
   * 当前 base64 CTE 下载荷行首不会出现 "."，此分支实际不触发；
   * 保留为对未来 CTE 变更（如 7bit / quoted-printable）的防御，勿删。
   */
  async writeRaw(raw: string): Promise<void> {
    const stuffed = raw
      .split("\r\n")
      .map((l) => (l.startsWith(".") ? "." + l : l))
      .join("\r\n");
    await this.writer.write(this.encoder.encode(stuffed));
  }

  async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      const m = /^(\d{3})([- ])/.exec(line);
      if (!m) throw new Error(`smtp: malformed reply: ${line}`);
      if (m[2] === " ") break; // 最终行（250-xxx 为续行）
    }
    const first = lines[0] ?? "";
    return { code: Number(first.slice(0, 3)), text: lines.join("\n"), lines };
  }

  async sendCommand(cmd: string): Promise<SmtpReply> {
    await this.writeLine(cmd);
    return this.readReply();
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        return line;
      }
      const chunk = await this.reader.read();
      if (chunk.done || chunk.value === undefined) {
        throw new Error("smtp: connection closed unexpectedly");
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("smtp: aborted before operation");
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("smtp: aborted (timeout or cancellation)")),
        { once: true },
      );
    }),
  ]);
}

async function expectOk(reply: SmtpReply, code: number, stage: string): Promise<SmtpReply> {
  if (reply.code !== code) {
    throw new NonRetryableError(`smtp: ${stage} failed: ${reply.code} ${reply.text}`);
  }
  return reply;
}

async function authenticate(
  session: SmtpSession,
  username: string,
  password: string,
  ehloLines: string[],
  signal: AbortSignal,
): Promise<void> {
  const authLine = ehloLines.find((l) => /^\d{3}[- ]AUTH\s/i.test(l)) ?? "";
  const mechanisms = authLine.toUpperCase().split(/\s+/).slice(1);
  if (mechanisms.includes("PLAIN")) {
    const reply = await raceAbort(
      session.sendCommand(`AUTH PLAIN ${base64Utf8(`\u0000${username}\u0000${password}`)}`),
      signal,
    );
    if (reply.code !== 235) {
      throw new NonRetryableError(`smtp: AUTH PLAIN rejected: ${reply.code} ${reply.text}`);
    }
    return;
  }
  if (mechanisms.includes("LOGIN")) {
    const r1 = await raceAbort(session.sendCommand("AUTH LOGIN"), signal);
    if (r1.code !== 334) throw new NonRetryableError(`smtp: AUTH LOGIN rejected: ${r1.code} ${r1.text}`);
    const r2 = await raceAbort(session.sendCommand(base64Utf8(username)), signal);
    if (r2.code !== 334) {
      throw new NonRetryableError(`smtp: AUTH LOGIN username rejected: ${r2.code} ${r2.text}`);
    }
    const r3 = await raceAbort(session.sendCommand(base64Utf8(password)), signal);
    if (r3.code !== 235) {
      throw new NonRetryableError(`smtp: AUTH LOGIN password rejected: ${r3.code} ${r3.text}`);
    }
    return;
  }
  throw new NonRetryableError("smtp: server offers no supported AUTH mechanism (PLAIN or LOGIN)");
}

function buildMimeMessage(options: SmtpSendOptions, messageId: string): string {
  const headers: string[] = [`From: ${formatAddress(options.from)}`];
  headers.push(`To: ${options.to.map(formatAddress).join(", ")}`);
  if (options.cc.length > 0) headers.push(`Cc: ${options.cc.map(formatAddress).join(", ")}`);
  headers.push(
    `Subject: ${encodeHeaderValue(options.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: ${options.bodyKind === "html" ? "text/html" : "text/plain"}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
  );
  const folded = base64Utf8(options.body).match(/.{1,76}/g) ?? [];
  return `${headers.join("\r\n")}\r\n\r\n${folded.join("\r\n")}\r\n`;
}

function formatAddress(a: ParsedAddress): string {
  return a.name === undefined ? a.address : `${encodeHeaderValue(a.name)} <${a.address}>`;
}

/** 头部值：字母数字与空格/连字符/下划线直出；其余（RFC specials、非 ASCII）整段 encoded-word
 *  （=?UTF-8?B?...?=）。含 specials（如 display-name 中的逗号）直出会破坏地址列表语法，
 *  encoded-word 内无分隔符语义，天然安全。 */
function encodeHeaderValue(value: string): string {
  if (/^[A-Za-z0-9 _-]*$/.test(value)) return value;
  return `=?UTF-8?B?${base64Utf8(value)}?=`;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "localhost" : address.slice(at + 1);
}

/**
 * 发送一封邮件（完整 SMTP 会话）。
 * 阶段分类（spec 3.5）：DATA 354 之前的失败 = 确定未发出（网络错可降级）；
 * 354 之后收到明确非 250 应答 = 确定未发出（NonRetryableError）；
 * 354 之后超时/断连 = 投递状态未知（DeliveryUncertainError，禁止降级）。
 */
export async function sendSmtpMail(
  options: SmtpSendOptions,
  signal: AbortSignal,
  connectFn: SmtpConnectFn = defaultConnect,
): Promise<SmtpSendResult> {
  const messageId = `<${crypto.randomUUID()}@${domainOf(options.from.address)}>`;
  let socket: SmtpSocket | null = null;
  try {
    // abort 先赢 race 时 socket 保持 null，finally 的 socket?.close() 为 no-op；
    // 此刻 signal.aborted 必为 true（abort 事件同步派发、reject 先 settle race），
    // 这个迟到的已建立连接无人接手，立即自关防泄漏（慢服务器场景）。
    const connectPromise = connectFn(options.host, options.port, {
      secureTransport: options.secure === "ssl" ? "on" : "starttls",
    }).then((late) => {
      if (signal.aborted) late.close().catch(() => {});
      return late;
    });
    socket = await raceAbort(connectPromise, signal);
    let session = SmtpSession.fromSocket(socket);
    await expectOk(await raceAbort(session.readReply(), signal), 220, "greeting");

    let ehloLines = (
      await expectOk(await raceAbort(session.sendCommand(`EHLO ${EHLO_NAME}`), signal), 250, "EHLO")
    ).lines;

    if (options.secure === "starttls") {
      if (!ehloLines.some((l) => /^\d{3}[- ]STARTTLS/i.test(l))) {
        throw new NonRetryableError("smtp: server does not advertise STARTTLS");
      }
      await expectOk(await raceAbort(session.sendCommand("STARTTLS"), signal), 220, "STARTTLS");
      // 同 connect：abort 先赢 race 时迟到的 TLS 升级 socket 立即自关
      // （finally 只会关 socket 指向的明文层，不保证关掉此包装层）。
      const tlsPromise = socket.startTls().then((late) => {
        if (signal.aborted) late.close().catch(() => {});
        return late;
      });
      const tlsSocket = await raceAbort(tlsPromise, signal);
      socket = tlsSocket;
      session = SmtpSession.fromSocket(tlsSocket);
      ehloLines = (
        await expectOk(
          await raceAbort(session.sendCommand(`EHLO ${EHLO_NAME}`), signal),
          250,
          "EHLO after STARTTLS",
        )
      ).lines;
    }

    await authenticate(session, options.username, options.password, ehloLines, signal);

    await expectOk(
      await raceAbort(session.sendCommand(`MAIL FROM:<${options.from.address}>`), signal),
      250,
      "MAIL FROM",
    );
    for (const r of [...options.to, ...options.cc, ...options.bcc]) {
      const reply = await raceAbort(session.sendCommand(`RCPT TO:<${r.address}>`), signal);
      if (reply.code !== 250 && reply.code !== 251) {
        throw new NonRetryableError(`smtp: RCPT TO <${r.address}> rejected: ${reply.code} ${reply.text}`);
      }
    }
    await expectOk(await raceAbort(session.sendCommand("DATA"), signal), 354, "DATA");

    // —— 354 之后：投递状态未知窗口 ——
    try {
      await raceAbort(session.writeRaw(buildMimeMessage(options, messageId)), signal);
      await raceAbort(session.writeLine("."), signal);
      const finalReply = await raceAbort(session.readReply(), signal);
      if (finalReply.code !== 250) {
        throw new NonRetryableError(
          `smtp: message rejected after DATA: ${finalReply.code} ${finalReply.text}`,
        );
      }
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new DeliveryUncertainError(`smtp: delivery uncertain after DATA: ${detail}`, {
        cause: err,
      });
    }

    try {
      // 尽力而为：QUIT 失败不影响已成功的结果
      await raceAbort(session.sendCommand("QUIT"), signal);
    } catch {
      /* ignore */
    }
    return { messageId };
  } catch (err) {
    if (err instanceof NonRetryableError || err instanceof DeliveryUncertainError) throw err;
    // 354 前的失败：确定未发出，按网络错归类（runner 可安全降级）
    throw classifyNetworkError(err);
  } finally {
    await socket?.close().catch(() => {});
  }
}
