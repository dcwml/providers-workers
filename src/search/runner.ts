import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import type { RequestRecorder } from "../telemetry";
import { anysearch } from "./providers/anysearch";
import { firecrawl } from "./providers/firecrawl";
import type { SearchProvider, SearchRequest } from "./types";

/** 供应商降级顺序，写死：anysearch → firecrawl。数组顺序即降级顺序。 */
export const SEARCH_CHAIN: readonly SearchProvider[] = [anysearch, firecrawl];

export const SEARCH_PROVIDER_IDS: readonly string[] = SEARCH_CHAIN.map((p) => p.id);

export function getSearchProviderById(id: string): SearchProvider | undefined {
  return SEARCH_CHAIN.find((p) => p.id === id);
}

export interface SearchOutcome {
  kind: "ok" | "all-failed";
  status: number;
  /** 成功时的上游 JSON 响应，原样透传 */
  body?: unknown;
  errors?: ProviderError[];
  /** 成功时由哪家供应商提供（kind=ok 才有），供监控记录 */
  providerOk?: string;
}

export async function runSearch(
  req: SearchRequest,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
  only?: SearchProvider,
  recorder?: RequestRecorder,
): Promise<SearchOutcome> {
  // ?provider= 覆盖：隔离只跑指定单家，不降级；缺省走固定链。
  const chain: readonly SearchProvider[] = only ? [only] : SEARCH_CHAIN;
  const errors: ProviderError[] = [];

  for (const provider of chain) {
    try {
      const result = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.search(req, env, signal);
        },
        {
          ...DEFAULT_RETRY,
          onAttempt: (info) =>
            recorder ? recorder.attempt(provider.id, info) : logAttempt("search", provider.id, info),
          ...retryOverrides,
        },
      );
      return { kind: "ok", status: 200, body: result.body, providerOk: provider.id };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
