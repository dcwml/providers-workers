import { RetryableError } from "./errors";

export interface AttemptInfo {
  /** 第几次尝试，从 1 开始 */
  attempt: number;
  /** ok=成功；retry=可重试失败将重试；fatal=最后一次失败或不可重试 */
  result: "ok" | "retry" | "fatal";
  elapsedMs: number;
  error?: unknown;
}

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 两次尝试之间的等待毫秒数，默认 1000 */
  delayMs?: number;
  onAttempt?: (info: AttemptInfo) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 只重试 RetryableError；其它错误立即抛出。
 * 重试耗尽后抛出最后一次的错误。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 1000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const value = await fn();
      options.onAttempt?.({ attempt, result: "ok", elapsedMs: Date.now() - start });
      return value;
    } catch (err) {
      const elapsedMs = Date.now() - start;
      if (err instanceof RetryableError && attempt < maxAttempts) {
        options.onAttempt?.({ attempt, result: "retry", elapsedMs, error: err });
        lastError = err;
        await sleep(delayMs);
        continue;
      }
      options.onAttempt?.({ attempt, result: "fatal", elapsedMs, error: err });
      throw err;
    }
  }
  throw lastError;
}
