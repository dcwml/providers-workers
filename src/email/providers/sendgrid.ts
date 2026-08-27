import {
  DeliveryUncertainError,
  NonRetryableError,
  classifyHttpStatus,
} from "../../errors";
import type { Env } from "../../env";
import type { EmailProvider, PreparedMail } from "../types";

const BASE_URL = "https://api.sendgrid.com/v3";
const ENV_KEY = "SENDGRID_API_KEY";
const FROM = { name: "Infility", address: "info@infility.cn" } as const;

function toApiAddress(a: { name?: string; address: string }): { email: string; name?: string } {
  return a.name === undefined ? { email: a.address } : { email: a.address, name: a.name };
}

export const sendgrid: EmailProvider = {
  id: "sendgrid",
  from: FROM,
  async send(mail: PreparedMail, env: Env, signal: AbortSignal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    const body = {
      personalizations: [
        {
          to: mail.to.map(toApiAddress),
          ...(mail.cc.length > 0 ? { cc: mail.cc.map(toApiAddress) } : {}),
          ...(mail.bcc.length > 0 ? { bcc: mail.bcc.map(toApiAddress) } : {}),
        },
      ],
      from: toApiAddress(FROM),
      subject: mail.subject,
      content: [
        { type: mail.bodyKind === "html" ? "text/html" : "text/plain", value: mail.body },
      ],
    };

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/mail/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // 超时/网络中断：请求可能已被上游受理，投递状态未知——禁止降级（spec 3.6）
      const detail = err instanceof Error ? err.message : String(err);
      throw new DeliveryUncertainError(
        `sendgrid: request failed, delivery may be uncertain: ${detail}`,
        { cause: err },
      );
    }

    if (!res.ok) throw classifyHttpStatus(res.status, await res.text());
    // 202 响应体为空；messageId 取 X-Message-Id 头，缺失则无
    const messageId = res.headers.get("x-message-id") ?? undefined;
    return messageId === undefined ? {} : { messageId };
  },
};
