import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import { getChain } from "./chains";
import type { ChatProvider, ChatRequest } from "./types";

export interface ChatOutcome {
  kind: "ok" | "all-failed";
  status: number;
  body?: unknown;
  errors?: ProviderError[];
}

export async function runChat(
  req: ChatRequest,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
  only?: ChatProvider,
): Promise<ChatOutcome> {
  // ?provider= 覆盖：隔离只跑指定单家，不降级；缺省走 model 对应的链。
  const chain: readonly ChatProvider[] = only ? [only] : getChain(req.model);

  const errors: ProviderError[] = [];
  for (const provider of chain) {
    try {
      const body = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.chat(req, env, signal);
        },
        {
          ...DEFAULT_RETRY,
          onAttempt: (info) => logAttempt("chat", provider.id, info),
          ...retryOverrides,
        },
      );
      return { kind: "ok", status: 200, body };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
