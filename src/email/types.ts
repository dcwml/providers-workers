import type { Env } from "../env";

export interface ParsedAddress {
  name?: string;
  address: string;
}

export interface PreparedMail {
  subject: string;
  /** html 与 text 同时提供时入口已按 html 归一 */
  bodyKind: "text" | "html";
  body: string;
  /** 已完成 to > cc > bcc 去重 */
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
}

export interface EmailSendResult {
  /** 上游返回时才有（SendGrid X-Message-Id / SMTP 自生成 Message-ID） */
  messageId?: string;
}

export interface EmailProvider {
  id: string;
  /** 内置发件人（写死在 provider 文件；请求体不接受 from） */
  from: ParsedAddress;
  send(mail: PreparedMail, env: Env, signal: AbortSignal): Promise<EmailSendResult>;
}
