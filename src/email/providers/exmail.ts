import { NonRetryableError } from "../../errors";
import type { Env } from "../../env";
import { sendSmtpMail } from "../smtp-client";
import type { EmailProvider, PreparedMail, ParsedAddress } from "../types";

const HOST = "smtp.exmail.qq.com";
const PORT = 465;
const SECURE = "ssl" as const;
const USERNAME = "info@infility.cn";
const FROM: ParsedAddress = { name: "Infility", address: "info@infility.cn" };
const ENV_KEY = "EXMAIL_SMTP_PASSWORD";

export const exmail: EmailProvider = {
  id: "exmail",
  from: FROM,
  async send(mail: PreparedMail, env: Env, signal: AbortSignal) {
    const password = env[ENV_KEY];
    if (!password) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    return sendSmtpMail(
      {
        host: HOST,
        port: PORT,
        secure: SECURE,
        username: USERNAME,
        password,
        from: FROM,
        to: mail.to,
        cc: mail.cc,
        bcc: mail.bcc,
        subject: mail.subject,
        bodyKind: mail.bodyKind,
        body: mail.body,
      },
      signal,
    );
  },
};
