export class RetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableError";
  }
}

export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** runner 聚合各家失败时使用的结构 */
export interface ProviderError {
  provider: string;
  message: string;
}

const BODY_SNIPPET_MAX = 300;

/** 按上游 HTTP 状态分类：429/5xx 可重试，其它 4xx 不可重试。 */
export function classifyHttpStatus(
  status: number,
  bodyText: string,
): RetryableError | NonRetryableError {
  const snippet = bodyText.slice(0, BODY_SNIPPET_MAX);
  const message = `upstream ${status}: ${snippet}`;
  if (status === 429 || status >= 500) return new RetryableError(message);
  return new NonRetryableError(message);
}

/** fetch 抛出的网络层错误（含超时 abort）一律可重试。 */
export function classifyNetworkError(err: unknown): RetryableError {
  const detail = err instanceof Error ? err.message : String(err);
  return new RetryableError(`network error: ${detail}`, { cause: err });
}
