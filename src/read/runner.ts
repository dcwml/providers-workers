import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import type { RequestRecorder } from "../telemetry";
import { firecrawl } from "./providers/firecrawl";
import { jina } from "./providers/jina";
import { tavily } from "./providers/tavily";
import type { ReaderProvider } from "./types";

/** 供应商降级顺序，写死：jina → tavily → firecrawl */
export const READ_CHAIN: readonly ReaderProvider[] = [jina, tavily, firecrawl];

export const READER_PROVIDER_IDS: readonly string[] = READ_CHAIN.map((p) => p.id);

export function getReaderProviderById(id: string): ReaderProvider | undefined {
  return READ_CHAIN.find((p) => p.id === id);
}

export interface ReadOutcome {
  kind: "ok" | "all-failed";
  status: number;
  markdown?: string;
  errors?: ProviderError[];
  /** 成功时由哪家供应商提供（kind=ok 才有），供监控记录 */
  providerOk?: string;
}

export async function runRead(
  url: string,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
  only?: ReaderProvider,
  recorder?: RequestRecorder,
): Promise<ReadOutcome> {
  // ?provider= 覆盖：隔离只跑指定单家，不降级；缺省走固定链。
  const chain: readonly ReaderProvider[] = only ? [only] : READ_CHAIN;
  const errors: ProviderError[] = [];

  for (const provider of chain) {
    try {
      const result = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.read(url, env, signal);
        },
        {
          ...DEFAULT_RETRY,
          onAttempt: (info) =>
            recorder ? recorder.attempt(provider.id, info) : logAttempt("read", provider.id, info),
          ...retryOverrides,
        },
      );
      return { kind: "ok", status: 200, markdown: result.markdown, providerOk: provider.id };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
