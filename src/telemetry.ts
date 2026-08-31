import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import type { ApiScope } from "./auth";
import { logAttempt } from "./log";
import type { AttemptInfo } from "./retry";

/** 遥测 feature 与 token 权限 scope 是同一份清单（加业务端点时同步扩 API_SCOPES）。 */
export type Feature = ApiScope;

export interface RecorderMeta {
  requestId: string;
  feature: Feature;
  endpoint: string;
  /** 请求体解析出逻辑 model 后由调用方改写（持有本对象引用即可） */
  model: string;
  tokenId: number | null;
}

export const INSERT_ATTEMPT_SQL =
  "INSERT INTO provider_attempts (request_id, feature, provider, model, attempt, result, elapsed_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

export const INSERT_REQUEST_SQL =
  "INSERT INTO requests (request_id, feature, endpoint, model, token_id, status, provider_ok, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

export function featureFromEndpoint(endpoint: string): Feature {
  if (endpoint.startsWith("/v1/chat")) return "chat";
  if (endpoint.startsWith("/v1/embeddings")) return "embeddings";
  if (endpoint.startsWith("/v1/rerank")) return "rerank";
  if (endpoint.startsWith("/v1/send-email")) return "email";
  if (endpoint.startsWith("/v1/search")) return "search";
  if (endpoint.startsWith("/v1/weather")) return "weather";
  return "read";
}

/**
 * 每次网关调用一个实例。所有 D1 写入经 ctx.waitUntil 异步执行：
 * 不增加请求延迟；写失败仅 console.warn，绝不影响业务响应。
 */
export class RequestRecorder {
  constructor(
    private readonly ctx: ExecutionContext,
    private readonly db: D1Database,
    private readonly meta: RecorderMeta,
  ) {}

  /** 供 runner 的 onAttempt 回调：先保持原有 console.log 行为，再异步落一行 provider_attempts。 */
  attempt(provider: string, info: AttemptInfo): void {
    logAttempt(this.meta.feature, provider, info);
    const error =
      info.error === undefined
        ? null
        : info.error instanceof Error
          ? info.error.message
          : String(info.error);
    const pending = this.db
      .prepare(INSERT_ATTEMPT_SQL)
      .bind(
        this.meta.requestId,
        this.meta.feature,
        provider,
        this.meta.model,
        info.attempt,
        info.result,
        info.elapsedMs,
        error,
      )
      .run()
      .catch((err: unknown) => {
        console.warn(`telemetry: failed to record attempt for ${provider}:`, err);
      });
    this.ctx.waitUntil(pending);
  }

  /** 响应前调用：落一行 requests。status 为最终响应状态码。 */
  finish(result: { status: number; providerOk?: string; elapsedMs: number }): void {
    const pending = this.db
      .prepare(INSERT_REQUEST_SQL)
      .bind(
        this.meta.requestId,
        this.meta.feature,
        this.meta.endpoint,
        this.meta.model,
        this.meta.tokenId,
        result.status,
        result.providerOk ?? null,
        result.elapsedMs,
      )
      .run()
      .catch((err: unknown) => {
        console.warn("telemetry: failed to record request:", err);
      });
    this.ctx.waitUntil(pending);
  }
}

/** 401 未授权调用：无 recorder，直接记一行 requests（token_id NULL、model 空）。 */
export function recordUnauthorized(
  ctx: ExecutionContext,
  db: D1Database,
  endpoint: string,
): void {
  const pending = db
    .prepare(INSERT_REQUEST_SQL)
    .bind(crypto.randomUUID(), featureFromEndpoint(endpoint), endpoint, "", null, 401, null, null)
    .run()
    .catch((err: unknown) => {
      console.warn("telemetry: failed to record unauthorized request:", err);
    });
  ctx.waitUntil(pending);
}
