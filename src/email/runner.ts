import { UPSTREAM_TIMEOUT_MS } from "../config";
import { DeliveryUncertainError, type ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry } from "../retry";
import type { RequestRecorder } from "../telemetry";
import { exmail } from "./providers/exmail";
import { sendgrid } from "./providers/sendgrid";
import type { EmailProvider, PreparedMail } from "./types";

/** 供应商降级顺序，写死：exmail → sendgrid（自有邮箱信誉优先，SendGrid 兜底）。 */
export const EMAIL_CHAIN: readonly EmailProvider[] = [exmail, sendgrid];

export const EMAIL_PROVIDER_IDS: readonly string[] = EMAIL_CHAIN.map((p) => p.id);

export function getEmailProviderById(id: string): EmailProvider | undefined {
  return EMAIL_CHAIN.find((p) => p.id === id);
}

export interface EmailOutcome {
  kind: "ok" | "uncertain" | "all-failed";
  status: number;
  body?: unknown;
  errors?: ProviderError[];
  /** 成功时由哪家供应商提供（kind=ok 才有），供监控记录 */
  providerOk?: string;
}

/**
 * 单次尝试 + 安全降级（与 chat/read 的 DEFAULT_RETRY 不同——邮件不幂等）：
 * 每家恰好发一次（maxAttempts:1，仅复用 withRetry 的遥测接线）；
 * 「确定没发出」的失败换下家；DeliveryUncertainError（投递状态未知）立即中止，不降级。
 */
export async function runEmail(
  mail: PreparedMail,
  env: Env,
  only?: EmailProvider,
  recorder?: RequestRecorder,
): Promise<EmailOutcome> {
  // ?provider= 覆盖：隔离只跑指定单家，不降级；缺省走固定链。
  const chain: readonly EmailProvider[] = only ? [only] : EMAIL_CHAIN;
  const errors: ProviderError[] = [];

  for (const provider of chain) {
    try {
      const result = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.send(mail, env, signal);
        },
        {
          maxAttempts: 1,
          onAttempt: (info) =>
            recorder ? recorder.attempt(provider.id, info) : logAttempt("email", provider.id, info),
        },
      );
      return {
        kind: "ok",
        status: 200,
        body: {
          accepted: true,
          provider: provider.id,
          ...(result.messageId === undefined ? {} : { message_id: result.messageId }),
        },
        providerOk: provider.id,
      };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof DeliveryUncertainError) {
        return { kind: "uncertain", status: 502, errors };
      }
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
