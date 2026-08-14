export const UPSTREAM_TIMEOUT_MS = 30_000;

export const DEFAULT_RETRY = {
  maxAttempts: 3,
  delayMs: 1000,
} as const;
