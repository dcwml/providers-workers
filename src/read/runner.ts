import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import { firecrawl } from "./providers/firecrawl";
import { jina } from "./providers/jina";
import { tavily } from "./providers/tavily";
import type { ReaderProvider } from "./types";

/** 供应商降级顺序，写死：jina → tavily → firecrawl */
export const READ_CHAIN: readonly ReaderProvider[] = [jina, tavily, firecrawl];

export interface ReadOutcome {
  kind: "ok" | "all-failed";
  status: number;
  markdown?: string;
  errors?: ProviderError[];
}

export async function runRead(
  url: string,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
): Promise<ReadOutcome> {
  const errors: ProviderError[] = [];

  for (const provider of READ_CHAIN) {
    try {
      const result = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.read(url, env, signal);
        },
        {
          ...DEFAULT_RETRY,
          onAttempt: (info) => logAttempt("read", provider.id, info),
          ...retryOverrides,
        },
      );
      return { kind: "ok", status: 200, markdown: result.markdown };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
