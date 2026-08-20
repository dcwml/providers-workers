import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import type { RequestRecorder } from "../telemetry";
import type { EmbeddingsProvider, EmbeddingsRequest } from "./types";

export interface EmbeddingsOutcome {
  kind: "ok" | "failed";
  status: number;
  body?: unknown;
  errors?: ProviderError[];
  /** 成功时由哪家供应商提供（kind=ok 才有），供监控记录 */
  providerOk?: string;
}

/**
 * 单 provider 形式：无链、无降级，失败即失败。
 * provider 由调用方解析（model 映射或 ?provider= 覆盖），本函数只负责带重试地执行。
 */
export async function runEmbeddings(
  req: EmbeddingsRequest,
  env: Env,
  provider: EmbeddingsProvider,
  retryOverrides?: Partial<RetryOptions>,
  recorder?: RequestRecorder,
): Promise<EmbeddingsOutcome> {
  try {
    const body = await withRetry(
      async () => {
        const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
        return provider.embed(req, env, signal);
      },
      {
        ...DEFAULT_RETRY,
        onAttempt: (info) =>
          recorder
            ? recorder.attempt(provider.id, info)
            : logAttempt("embeddings", provider.id, info),
        ...retryOverrides,
      },
    );
    return { kind: "ok", status: 200, body, providerOk: provider.id };
  } catch (err) {
    return {
      kind: "failed",
      status: 502,
      errors: [
        {
          provider: provider.id,
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}
