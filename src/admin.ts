import { constantTimeEquals, normalizeScopes, parseScopes, sha256Hex } from "./auth";
import type { WorkerEnv } from "./env";

export const LIST_SQL = "SELECT id, label, token_mask, enabled, created_at, scopes FROM tokens ORDER BY id";
export const INSERT_SQL =
  "INSERT INTO tokens (token_hash, token_prefix, token_mask, label, scopes) VALUES (?, ?, ?, ?, ?)";
export const UPDATE_SQL = "UPDATE tokens SET enabled = ? WHERE id = ?";
export const UPDATE_SCOPES_SQL = "UPDATE tokens SET scopes = ? WHERE id = ?";
export const DELETE_SQL = "DELETE FROM tokens WHERE id = ?";

/** 掩码：完整保留手填前缀（非机密），随机段只露前4后4。 */
export function tokenMask(prefix: string, random: string): string {
  return `${prefix}${random.slice(0, 4)}...${random.slice(-4)}`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function isAdminAuthorized(request: Request, adminToken: string | undefined): Promise<boolean> {
  if (!adminToken) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return false;
  return constantTimeEquals(match[1].trim(), adminToken);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleAdminApi(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json(404, { error: { message: "not found" } });
  if (!(await isAdminAuthorized(request, env.ADMIN_TOKEN))) {
    return json(401, { error: { message: "unauthorized" } });
  }

  const path = new URL(request.url).pathname;

  if (path === "/admin/api/tokens" && request.method === "GET") {
    let results: {
      id: number;
      label: string;
      token_mask: string;
      enabled: number;
      created_at: string;
      scopes: string | null;
    }[];
    try {
      const result = await env.DB.prepare(LIST_SQL).all<{
        id: number;
        label: string;
        token_mask: string;
        enabled: number;
        created_at: string;
        scopes: string | null;
      }>();
      results = result.results;
    } catch {
      return json(500, { error: { message: "database error", code: "db_error" } });
    }
    // scopes 以数组返回；空数组 = 不限制（可调用全部接口）。
    const tokens = results.map((row) => ({ ...row, scopes: parseScopes(row.scopes) }));
    return json(200, { tokens });
  }

  if (path === "/admin/api/tokens" && request.method === "POST") {
    const body = (await readJsonBody(request)) as
      | { prefix?: unknown; random?: unknown; label?: unknown; scopes?: unknown }
      | undefined;
    const parsed = body ?? {};
    const prefix = typeof parsed.prefix === "string" ? parsed.prefix.trim() : "";
    const random = typeof parsed.random === "string" ? parsed.random.trim() : "";
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    let scopes = "";
    if (parsed.scopes !== undefined) {
      const normalized = normalizeScopes(parsed.scopes);
      if (!normalized.ok) {
        return json(400, { error: { message: normalized.message, code: "invalid_scopes" } });
      }
      scopes = normalized.value;
    }
    if (prefix.length === 0 && random.length === 0) {
      return json(400, { error: { message: "prefix and random cannot both be empty", code: "empty_token" } });
    }
    if (random.length < 8) {
      return json(400, { error: { message: "random part must be at least 8 characters", code: "random_too_short" } });
    }
    const token = prefix + random;
    const tokenHash = await sha256Hex(token);
    const mask = tokenMask(prefix, random);
    let lastRowId: number | null;
    try {
      const result = await env.DB.prepare(INSERT_SQL).bind(tokenHash, prefix, mask, label, scopes).run();
      lastRowId = result.meta.last_row_id ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed")) {
        return json(409, { error: { message: "token already exists", code: "duplicate_token" } });
      }
      return json(500, { error: { message: "database error", code: "db_error" } });
    }
    // 完整 token 仅此一次返回，此后库里只剩哈希与掩码。
    return json(201, { id: lastRowId, token, token_mask: mask, scopes: parseScopes(scopes) });
  }

  const idMatch = path.match(/^\/admin\/api\/tokens\/(\d+)$/);
  if (idMatch && idMatch[1] !== undefined) {
    const id = Number(idMatch[1]);

    if (request.method === "PATCH") {
      const body = ((await readJsonBody(request)) ?? {}) as { enabled?: unknown; scopes?: unknown };
      let enabledValue: number | null = null;
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return json(400, { error: { message: "enabled must be a boolean", code: "invalid_enabled" } });
        }
        enabledValue = body.enabled ? 1 : 0;
      }
      let scopesValue: string | null = null;
      if (body.scopes !== undefined) {
        const normalized = normalizeScopes(body.scopes);
        if (!normalized.ok) {
          return json(400, { error: { message: normalized.message, code: "invalid_scopes" } });
        }
        scopesValue = normalized.value;
      }
      if (enabledValue === null && scopesValue === null) {
        return json(400, { error: { message: "enabled or scopes is required", code: "invalid_patch" } });
      }
      let changes = 0;
      try {
        if (enabledValue !== null) {
          const result = await env.DB.prepare(UPDATE_SQL).bind(enabledValue, id).run();
          changes += result.meta.changes ?? 0;
        }
        if (scopesValue !== null) {
          const result = await env.DB.prepare(UPDATE_SCOPES_SQL).bind(scopesValue, id).run();
          changes += result.meta.changes ?? 0;
        }
      } catch {
        return json(500, { error: { message: "database error", code: "db_error" } });
      }
      if (changes === 0) {
        return json(404, { error: { message: "token not found", code: "token_not_found" } });
      }
      return json(200, { ok: true });
    }

    if (request.method === "DELETE") {
      let changes: number;
      try {
        const result = await env.DB.prepare(DELETE_SQL).bind(id).run();
        changes = result.meta.changes ?? 0;
      } catch {
        return json(500, { error: { message: "database error", code: "db_error" } });
      }
      if (changes === 0) {
        return json(404, { error: { message: "token not found", code: "token_not_found" } });
      }
      return json(200, { ok: true });
    }
  }

  return json(404, { error: { message: "not found" } });
}
