import type { AttemptInfo } from "./retry";

export function logAttempt(
  feature: "chat" | "read",
  provider: string,
  info: AttemptInfo,
): void {
  const errPart =
    info.error !== undefined
      ? ` error="${info.error instanceof Error ? info.error.message : String(info.error)}"`
      : "";
  console.log(
    `[${feature}] provider=${provider} attempt=${info.attempt} result=${info.result} elapsed=${info.elapsedMs}ms${errPart}`,
  );
}
