import type { D1Database } from "@cloudflare/workers-types";

/** 业务接口权限（scope）全集，与遥测 Feature 一一对应；scopes 存库为逗号分隔字符串。 */
export const API_SCOPES = ["chat", "read", "search", "embeddings", "rerank", "email"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export type AuthResult =
  | { ok: true; tokenId: number; scopes: string[] }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "db-error" };

export const TOKEN_LOOKUP_SQL = "SELECT id, scopes FROM tokens WHERE token_hash = ? AND enabled = 1";

/** 解析 tokens.scopes 存库值：空串/NULL = 不限制，返回空数组；其余按逗号拆分去空。 */
export function parseScopes(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 空列表 = 不限制（未配置权限的存量 token 保持全接口可用）。 */
export function scopeAllowed(scopes: string[], required: ApiScope): boolean {
  return scopes.length === 0 || scopes.includes(required);
}

/** 管理端写入解析：字符串数组 → 去重小写 CSV；空数组 = 不限制（存空串）；未知 scope 名拒绝。 */
export function normalizeScopes(
  input: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  if (!Array.isArray(input)) return { ok: false, message: "scopes must be an array of scope names" };
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") {
      return { ok: false, message: "scopes must be an array of scope names" };
    }
    const scope = item.trim().toLowerCase();
    if (!(API_SCOPES as readonly string[]).includes(scope)) {
      return {
        ok: false,
        message: `unknown scope: ${item}; valid scopes: ${API_SCOPES.join(", ")}`,
      };
    }
    seen.add(scope);
  }
  return { ok: true, value: [...seen].join(",") };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 恒时字符串比较：先各自 SHA-256 定长，再逐字节 XOR 累计，避免时序侧信道。供 ADMIN_TOKEN 校验复用。 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const aBytes = new Uint8Array(ha);
  const bBytes = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/**
 * 业务接口鉴权：对传入 token 算 SHA-256，按哈希查 tokens 表（enabled=1），同时带出 scopes。
 * 哈希查库无非对称时序面，不需要逐 token 常量时间比较。
 */
export async function authorize(request: Request, db: D1Database): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return { ok: false, reason: "missing" };
  const provided = match[1].trim();
  if (provided.length === 0) return { ok: false, reason: "missing" };

  const tokenHash = await sha256Hex(provided);
  let row: { id: number; scopes: string | null } | null;
  try {
    row = await db.prepare(TOKEN_LOOKUP_SQL).bind(tokenHash).first<{ id: number; scopes: string | null }>();
  } catch {
    return { ok: false, reason: "db-error" };
  }
  if (row === null) return { ok: false, reason: "invalid" };
  return { ok: true, tokenId: row.id, scopes: parseScopes(row.scopes) };
}
