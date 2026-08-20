# D1 Token 管理 + 供应商监控 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 providers 网关的鉴权 token 迁入 D1 并提供 Worker 内置管理页；同时把每次网关调用与每次供应商上游尝试持久化到 D1 供 SQL 监控。

**Architecture:** 方案 A"D1 一库全包"（spec：`docs/superpowers/specs/2026-08-19-d1-token-admin-monitoring-design.md`）。鉴权从 env CSV 常量时间比较改为 SHA-256 哈希查 D1 tokens 表；埋点走新增 `RequestRecorder`，所有写库经 `ctx.waitUntil()` 异步执行、失败仅 warn；`/admin` 静态登录壳 + `/admin/api/*`（Bearer ADMIN_TOKEN）管理 token。

**Tech Stack:** Cloudflare Workers（原生 fetch handler，无框架无运行时依赖）、D1（binding `DB`，库 `providers_db`）、TypeScript strict、vitest（全 mock）。

## Global Constraints

- 平台：仅 Cloudflare Workers，**禁止 Node API**（无 `crypto.timingSafeEqual` 等）。
- TS：`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`；**禁止 `any`**（用 `unknown` + 显式转换；类型化接口转 Record 需 `as unknown as`）。
- 测试：vitest，D1 与上游 fetch 全 mock，**禁止真实网络/真实 D1 调用**。
- 业务行为不得改变：上游响应原样透传、重试/降级语义、错误体风格（chat/embeddings/rerank 用 OpenAI 风格 `{error:{message,type,code,provider_errors?}}`，read 用简化形）。
- **不得修改 `src/*/providers/*.ts` 任何供应商文件**。
- 错误码风格：snake_case（如 `auth_store_error`、`duplicate_token`）。
- D1 库已存在：`database_name = "providers_db"`，`database_id = "3e4ea628-5362-4c9d-97f5-7a788230ada4"`。
- **禁止执行** `git push`、`wrangler deploy`、`wrangler secret put/delete`、任何 `--remote` 的 D1 命令——生产上线走计划末尾的 Runbook，由用户确认后执行。`--local` 的 D1 命令可以用。
- 本机 shell 是 MSYS bash（虽显示 cmd.exe）：`%TEMP%`/`type` 等 cmd 语法不可用；curl 传中文 body 会编码破损，冒烟一律用 ASCII body。
- 每个任务收尾验收：`npm run typecheck && npm test` 全绿（除非任务另有说明）。
- 提交信息用仓库现有风格：`feat:`/`docs:` 前缀、英文一行。

---

### Task 1: D1 schema、binding 与 WorkerEnv 类型（纯基建，无行为变化）

**Files:**
- Create: `migrations/0001_init.sql`
- Modify: `wrangler.toml`（文件末尾追加）
- Modify: `src/env.ts`
- Create: `test/helpers.ts`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `WorkerEnv = Env & { DB: D1Database }`（后续所有任务用）；测试工具 `makeFakeD1(): FakeD1Handle`（`{ db, statements, setRows, setRunMeta, failOnSubstring }`）与 `makeFakeCtx(): FakeCtxHandle`（`{ ctx, promises }`）。

- [ ] **Step 1: 写迁移文件 `migrations/0001_init.sql`**

```sql
-- token 管理 + 请求/供应商尝试监控（spec: docs/superpowers/specs/2026-08-19-d1-token-admin-monitoring-design.md）
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL DEFAULT '',
  token_mask TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  feature TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  token_id INTEGER REFERENCES tokens(id) ON DELETE SET NULL,
  status INTEGER NOT NULL,
  provider_ok TEXT,
  elapsed_ms INTEGER
);
CREATE INDEX idx_requests_created ON requests(created_at);
CREATE INDEX idx_requests_token ON requests(token_id);

CREATE TABLE provider_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  feature TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('ok','retry','fatal')),
  elapsed_ms INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX idx_attempts_provider_created ON provider_attempts(provider, created_at);
CREATE INDEX idx_attempts_request ON provider_attempts(request_id);
```

- [ ] **Step 2: `wrangler.toml` 末尾追加 D1 binding**

在现有三行（name/main/compatibility_date）之后追加：

```toml

[[d1_databases]]
binding = "DB"
database_name = "providers_db"
database_id = "3e4ea628-5362-4c9d-97f5-7a788230ada4"
migrations_dir = "migrations"
```

- [ ] **Step 3: 修改 `src/env.ts`——加 ADMIN_TOKEN 可选声明与 WorkerEnv 类型**

`AUTH_TOKENS: string;` 本任务**保留**（Task 2 才移除）。完整新文件内容：

```ts
export interface Env {
  AUTH_TOKENS: string;
  ADMIN_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  AGNES_API_KEY?: string;
  SILICONFLOW_API_KEY?: string;
  GPTSAPI_API_KEY?: string;
  JINA_API_KEY?: string;
  TAVILY_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  /** 允许供应商声明各自的其它 key 名 */
  [key: string]: string | undefined;
}

/**
 * Worker 入口实际收到的 env：Env + D1 binding。
 * DB 是对象类型，不放进 Env（避免与 string index signature 冲突，供应商 env[ENV_KEY] 用法不受影响）。
 */
export type WorkerEnv = Env & { DB: D1Database };
```

- [ ] **Step 4: 写测试工具 `test/helpers.ts`（假 D1 + 假 ExecutionContext）**

```ts
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

export interface RecordedStatement {
  sql: string;
  params: unknown[];
  method: "first" | "run" | "all";
}

export interface FakeD1Handle {
  db: D1Database;
  /** 按 prepare(sql) 调用顺序记录的语句（含 bind 后参数） */
  statements: RecordedStatement[];
  /** 按 SQL 精确键设置 first()/all() 的返回行 */
  setRows(sql: string, rows: Record<string, unknown>[]): void;
  /** 按 SQL 精确键覆盖 run() 的 meta（默认 { changes: 1, last_row_id: 1 }） */
  setRunMeta(sql: string, meta: Record<string, unknown>): void;
  /** 命中 SQL 子串时让该语句抛错（模拟 D1 故障/约束冲突）；substring 传 null 清除 */
  failOnSubstring(substring: string | null, message?: string): void;
}

export function makeFakeD1(): FakeD1Handle {
  const rowsBySql = new Map<string, Record<string, unknown>[]>();
  const metaBySql = new Map<string, Record<string, unknown>>();
  const statements: RecordedStatement[] = [];
  let failOn: string | null = null;
  let failMessage = "simulated d1 failure";

  function maybeFail(sql: string): void {
    if (failOn !== null && sql.includes(failOn)) {
      throw new Error(failMessage);
    }
  }

  function makeStmt(sql: string, params: unknown[]): Record<string, unknown> {
    return {
      bind: (...values: unknown[]) => makeStmt(sql, [...params, ...values]),
      first: async (): Promise<unknown> => {
        statements.push({ sql, params, method: "first" });
        maybeFail(sql);
        const rows = rowsBySql.get(sql);
        const row = rows === undefined ? undefined : rows[0];
        return row === undefined ? null : row;
      },
      run: async (): Promise<{ success: true; meta: Record<string, unknown> }> => {
        statements.push({ sql, params, method: "run" });
        maybeFail(sql);
        const meta = metaBySql.get(sql) ?? { changes: 1, last_row_id: 1 };
        return { success: true, meta };
      },
      all: async (): Promise<{ results: Record<string, unknown>[]; success: true }> => {
        statements.push({ sql, params, method: "all" });
        maybeFail(sql);
        return { results: rowsBySql.get(sql) ?? [], success: true };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;

  return {
    db,
    statements,
    setRows: (sql, rows) => rowsBySql.set(sql, rows),
    setRunMeta: (sql, meta) => metaBySql.set(sql, meta),
    failOnSubstring: (substring, message) => {
      failOn = substring;
      failMessage = message ?? "simulated d1 failure";
    },
  };
}

export interface FakeCtxHandle {
  ctx: ExecutionContext;
  /** waitUntil 收到的 promise；测试里 await Promise.all(handle.promises) 确认落库完成且不抛错 */
  promises: Promise<unknown>[];
}

export function makeFakeCtx(): FakeCtxHandle {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>): void => {
      promises.push(p);
    },
  } as unknown as ExecutionContext;
  return { ctx, promises };
}
```

- [ ] **Step 5: 本地验证迁移可应用**

Run: `npx wrangler d1 migrations apply providers_db --local`
Expected: 显示找到 `0001_init.sql` 并成功应用（🚣 To apply / ✅ success 字样；若本机 DNS 偶发失败重试一次——这是已知环境问题）。

Run: `npx wrangler d1 execute providers_db --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`
Expected: 输出包含 `d1_migrations`、`provider_attempts`、`requests`、`tokens` 四个表名。

- [ ] **Step 6: 类型与全量测试验收**

Run: `npm run typecheck && npm test`
Expected: 全绿（本任务未改任何运行时行为）。

- [ ] **Step 7: Commit**

```bash
git add migrations/0001_init.sql wrangler.toml src/env.ts test/helpers.ts
git commit -m "feat: add D1 binding, schema migration, and WorkerEnv type"
```

---

### Task 2: 鉴权切换到 D1（authorize + 500 语义 + 废弃 AUTH_TOKENS）

**Files:**
- Modify: `src/auth.ts`（整文件重写）
- Modify: `src/index.ts:1-35`（import 与 guard）
- Modify: `src/env.ts`（移除 AUTH_TOKENS）
- Rewrite: `test/auth.test.ts`
- Modify: `test/index.test.ts`（env 构造与鉴权用例）

**Interfaces:**
- Consumes: Task 1 的 `WorkerEnv`、`makeFakeD1`。
- Produces（后续任务依赖）:
  - `authorize(request: Request, db: D1Database): Promise<AuthResult>`，`AuthResult = { ok: true; tokenId: number } | { ok: false; reason: "missing" | "invalid" | "db-error" }`
  - `sha256Hex(value: string): Promise<string>`（Task 6 admin 用）
  - `constantTimeEquals(a: string, b: string): Promise<boolean>`（Task 6 admin 用）
  - `TOKEN_LOOKUP_SQL = "SELECT id FROM tokens WHERE token_hash = ? AND enabled = 1"`（测试 stub 用）
  - index.ts 401 body 不变 `{error:{message:"unauthorized"}}`；D1 故障 500 `{error:{message:"auth store unavailable",type:"server_error",code:"auth_store_error"}}`

- [ ] **Step 1: 重写 `test/auth.test.ts`（先写失败测试）**

```ts
import { describe, expect, it } from "vitest";
import { authorize, constantTimeEquals, sha256Hex, TOKEN_LOOKUP_SQL } from "../src/auth";
import { makeFakeD1 } from "./helpers";

function makeRequest(auth?: string): Request {
  const headers = new Headers();
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request("https://gateway.example/v1/read", { headers });
}

describe("authorize", () => {
  it("authorizes a known enabled token and returns its id", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, [{ id: 7 }]);
    const result = await authorize(makeRequest("Bearer sekret"), fake.db);
    expect(result).toEqual({ ok: true, tokenId: 7 });
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.params[0]).toEqual(await sha256Hex("sekret"));
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, [{ id: 1 }]);
    expect(await authorize(makeRequest("bearer sekret"), fake.db)).toEqual({ ok: true, tokenId: 1 });
  });

  it("rejects an unknown or disabled token (no row) as invalid", async () => {
    const fake = makeFakeD1();
    fake.setRows(TOKEN_LOOKUP_SQL, []);
    expect(await authorize(makeRequest("Bearer nope"), fake.db)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a missing authorization header as missing", async () => {
    const fake = makeFakeD1();
    expect(await authorize(makeRequest(), fake.db)).toEqual({ ok: false, reason: "missing" });
    expect(fake.statements).toHaveLength(0);
  });

  it("rejects a non-Bearer scheme as missing", async () => {
    const fake = makeFakeD1();
    expect(await authorize(makeRequest("Basic sekret"), fake.db)).toEqual({ ok: false, reason: "missing" });
  });

  it("maps D1 failures to db-error", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(TOKEN_LOOKUP_SQL);
    expect(await authorize(makeRequest("Bearer sekret"), fake.db)).toEqual({ ok: false, reason: "db-error" });
  });
});

describe("sha256Hex", () => {
  it("produces the known hex digest for a fixed input", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("constantTimeEquals", () => {
  it("matches identical strings and rejects different ones regardless of length", async () => {
    expect(await constantTimeEquals("a", "a")).toBe(true);
    expect(await constantTimeEquals("a", "b")).toBe(false);
    expect(await constantTimeEquals("a", "aa")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL——`authorize` 等导出不存在（当前 auth.ts 只有 `isAuthorized`）。

- [ ] **Step 3: 重写 `src/auth.ts`**

```ts
import type { D1Database } from "@cloudflare/workers-types";

export type AuthResult =
  | { ok: true; tokenId: number }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "db-error" };

export const TOKEN_LOOKUP_SQL = "SELECT id FROM tokens WHERE token_hash = ? AND enabled = 1";

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
 * 业务接口鉴权：对传入 token 算 SHA-256，按哈希查 tokens 表（enabled=1）。
 * 哈希查库无非对称时序面，不需要逐 token 常量时间比较。
 */
export async function authorize(request: Request, db: D1Database): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return { ok: false, reason: "missing" };
  const provided = match[1].trim();
  if (provided.length === 0) return { ok: false, reason: "missing" };

  const tokenHash = await sha256Hex(provided);
  let row: { id: number } | null;
  try {
    row = await db.prepare(TOKEN_LOOKUP_SQL).bind(tokenHash).first<{ id: number }>();
  } catch {
    return { ok: false, reason: "db-error" };
  }
  if (row === null) return { ok: false, reason: "invalid" };
  return { ok: true, tokenId: row.id };
}
```

- [ ] **Step 4: 修改 `src/index.ts` 的 import 与 guard**

第一行 `import { isAuthorized } from "./auth";` 改为：

```ts
import { authorize } from "./auth";
```

`guard` 函数整体替换为：

```ts
async function guard(request: Request, env: WorkerEnv): Promise<Response | null> {
  const result = await authorize(request, env.DB);
  if (result.ok) return null;
  if (result.reason === "db-error") {
    return json(500, {
      error: { message: "auth store unavailable", type: "server_error", code: "auth_store_error" },
    });
  }
  return json(401, { error: { message: "unauthorized" } });
}
```

import 区 `import type { Env } from "./env";` 改为：

```ts
import type { WorkerEnv } from "./env";
```

文件内其余 `env: Env` 的函数签名（handleChat/handleRead/handleEmbeddings/handleRerank 与 fetch）全部改为 `env: WorkerEnv`（`Env` 不再被 import）。

- [ ] **Step 5: `src/env.ts` 移除 `AUTH_TOKENS: string;` 一行**（其余不动）

- [ ] **Step 6: 更新 `test/index.test.ts`**

顶部 import 区改动——`import type { Env } from "../src/env";` 替换为：

```ts
import { TOKEN_LOOKUP_SQL } from "../src/auth";
import type { WorkerEnv } from "../src/env";
import { makeFakeD1 } from "./helpers";
```

`const env: Env = { AUTH_TOKENS: "sekret" };` 替换为：

```ts
function makeEnv(rows: Record<string, unknown>[] = [{ id: 7 }]): WorkerEnv {
  const fake = makeFakeD1();
  fake.setRows(TOKEN_LOOKUP_SQL, rows);
  return { DB: fake.db } as WorkerEnv;
}

const env = makeEnv();
```

说明：假 D1 的 `first()` 不区分 bind 参数，默认行让任意 Bearer token 放行；"错误 token"场景用 `makeEnv([])` 单独构造。

`describe("auth")` 整块替换为：

```ts
describe("auth", () => {
  it("rejects missing token with 401", async () => {
    const req = new Request("https://gw.example/v1/read", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects wrong token with 401 even for invalid body (auth runs first)", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "not json",
    });
    const res = await handler.fetch(req, makeEnv([]));
    expect(res.status).toBe(401);
  });

  it("returns 500 when the token store (D1) fails", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(TOKEN_LOOKUP_SQL);
    const envDown: WorkerEnv = { DB: fake.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), envDown);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { message: "auth store unavailable", type: "server_error", code: "auth_store_error" },
    });
  });
});
```

- [ ] **Step 7: 运行本任务测试与全量验收**

Run: `npx vitest run test/auth.test.ts test/index.test.ts`
Expected: PASS。

Run: `npm run typecheck && npm test`
Expected: 全绿（runner 测试里的 `{ AUTH_TOKENS: "" }` env 字面量被 Env 的 index signature 吸收，不需改动）。

- [ ] **Step 8: Commit**

```bash
git add src/auth.ts src/index.ts src/env.ts test/auth.test.ts test/index.test.ts
git commit -m "feat: switch gateway auth to D1 token lookup and drop AUTH_TOKENS"
```

---

### Task 3: 监控埋点模块 `src/telemetry.ts`（RequestRecorder）

**Files:**
- Create: `src/telemetry.ts`
- Create: `test/telemetry.test.ts`

**Interfaces:**
- Consumes: `src/retry.ts` 的 `AttemptInfo`（已存在）、`src/log.ts` 的 `logAttempt`（已存在）、Task 1 的测试工具。
- Produces（Task 5 依赖）:
  - `type Feature = "chat" | "read" | "embeddings" | "rerank"`
  - `interface RecorderMeta { requestId: string; feature: Feature; endpoint: string; model: string; tokenId: number | null }`（model 可被持有者后续改写，recorder 持引用）
  - `class RequestRecorder { constructor(ctx: ExecutionContext, db: D1Database, meta: RecorderMeta); attempt(provider: string, info: AttemptInfo): void; finish(result: { status: number; providerOk?: string; elapsedMs: number }): void }`
  - `recordUnauthorized(ctx: ExecutionContext, db: D1Database, endpoint: string): void`
  - `featureFromEndpoint(endpoint: string): Feature`
  - `INSERT_ATTEMPT_SQL = "INSERT INTO provider_attempts (request_id, feature, provider, model, attempt, result, elapsed_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"`
  - `INSERT_REQUEST_SQL = "INSERT INTO requests (request_id, feature, endpoint, model, token_id, status, provider_ok, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"`

- [ ] **Step 1: 写失败测试 `test/telemetry.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptInfo } from "../src/retry";
import {
  featureFromEndpoint,
  INSERT_ATTEMPT_SQL,
  INSERT_REQUEST_SQL,
  recordUnauthorized,
  RequestRecorder,
  type RecorderMeta,
} from "../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "./helpers";

const meta: RecorderMeta = {
  requestId: "req-1",
  feature: "chat",
  endpoint: "/v1/chat/completions",
  model: "m1",
  tokenId: 7,
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RequestRecorder.attempt", () => {
  it("keeps the console.log line and writes one provider_attempts row via waitUntil", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    const info: AttemptInfo = { attempt: 2, result: "retry", elapsedMs: 12, error: new Error("boom") };
    rec.attempt("agnes", info);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("provider=agnes"));
    await Promise.all(c.promises);
    expect(d1.statements).toHaveLength(1);
    expect(d1.statements[0]?.sql).toBe(INSERT_ATTEMPT_SQL);
    expect(d1.statements[0]?.params).toEqual(["req-1", "chat", "agnes", "m1", 2, "retry", 12, "boom"]);
  });

  it("writes null error on success attempts", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.attempt("agnes", { attempt: 1, result: "ok", elapsedMs: 5 });
    await Promise.all(c.promises);
    expect(d1.statements[0]?.params[7]).toBeNull();
  });
});

describe("RequestRecorder.finish", () => {
  it("writes one requests row with the outcome fields", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.finish({ status: 200, providerOk: "agnes", elapsedMs: 33 });
    await Promise.all(c.promises);
    expect(d1.statements).toHaveLength(1);
    expect(d1.statements[0]?.sql).toBe(INSERT_REQUEST_SQL);
    expect(d1.statements[0]?.params).toEqual([
      "req-1", "chat", "/v1/chat/completions", "m1", 7, 200, "agnes", 33,
    ]);
  });

  it("writes null provider_ok when absent", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.finish({ status: 502, elapsedMs: 90 });
    await Promise.all(c.promises);
    expect(d1.statements[0]?.params[6]).toBeNull();
  });
});

describe("write failures never break the request", () => {
  it("swallows D1 insert failures with console.warn only", async () => {
    const d1 = makeFakeD1();
    d1.failOnSubstring("INSERT INTO");
    const c = makeFakeCtx();
    const rec = new RequestRecorder(c.ctx, d1.db, meta);
    rec.attempt("agnes", { attempt: 1, result: "ok", elapsedMs: 5 });
    rec.finish({ status: 200, elapsedMs: 8 });
    await expect(Promise.all(c.promises)).resolves.toHaveLength(2);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe("recordUnauthorized", () => {
  it("writes a 401 requests row with derived feature and empty model", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    recordUnauthorized(c.ctx, d1.db, "/v1/read");
    await Promise.all(c.promises);
    expect(d1.statements).toHaveLength(1);
    const params = d1.statements[0]?.params as unknown[];
    expect(typeof params[0]).toBe("string");
    expect(params.slice(1)).toEqual(["read", "/v1/read", "", null, 401, null, null]);
  });
});

describe("featureFromEndpoint", () => {
  it("maps endpoints to features", () => {
    expect(featureFromEndpoint("/v1/chat/completions")).toBe("chat");
    expect(featureFromEndpoint("/v1/embeddings")).toBe("embeddings");
    expect(featureFromEndpoint("/v1/rerank")).toBe("rerank");
    expect(featureFromEndpoint("/v1/read")).toBe("read");
    expect(featureFromEndpoint("/anything-else")).toBe("read");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/telemetry.test.ts`
Expected: FAIL——模块 `../src/telemetry` 不存在。

- [ ] **Step 3: 实现 `src/telemetry.ts`**

```ts
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { logAttempt } from "./log";
import type { AttemptInfo } from "./retry";

export type Feature = "chat" | "read" | "embeddings" | "rerank";

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
```

- [ ] **Step 4: 运行确认通过 + 全量验收**

Run: `npx vitest run test/telemetry.test.ts` → PASS。
Run: `npm run typecheck && npm test` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/telemetry.ts test/telemetry.test.ts
git commit -m "feat: add RequestRecorder telemetry module for D1 logging"
```

---

### Task 4: 四个 runner 接入 recorder，outcome 暴露 providerOk

**Files:**
- Modify: `src/chat/runner.ts`
- Modify: `src/read/runner.ts`
- Modify: `src/embeddings/runner.ts`
- Modify: `src/rerank/runner.ts`
- Modify: `test/chat/runner.test.ts`、`test/read/runner.test.ts`、`test/embeddings/runner.test.ts`、`test/rerank/runner.test.ts`（各加一个用例）

**Interfaces:**
- Consumes: Task 3 的 `RequestRecorder`；现有 `logAttempt`、`withRetry`。
- Produces（Task 5 依赖）:
  - `runChat(req, env, retryOverrides?, only?, recorder?: RequestRecorder): Promise<ChatOutcome>`
  - `runRead(url, env, retryOverrides?, only?, recorder?: RequestRecorder): Promise<ReadOutcome>`
  - `runEmbeddings(req, env, provider, retryOverrides?, recorder?: RequestRecorder): Promise<EmbeddingsOutcome>`
  - `runRerank(req, env, provider, retryOverrides?, recorder?: RequestRecorder): Promise<RerankOutcome>`
  - 四个 Outcome 接口均新增 `providerOk?: string`（kind=ok 时为成功供应商 id）。

- [ ] **Step 1: 在 `test/chat/runner.test.ts` 末尾追加失败测试（describe 内）**

文件顶部 import 区追加：

```ts
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "../helpers";
```

追加用例：

```ts
it("records attempts via recorder and reports providerOk on success", async () => {
  const d1 = makeFakeD1();
  const c = makeFakeCtx();
  const recorder = new RequestRecorder(c.ctx, d1.db, {
    requestId: "r1", feature: "chat", endpoint: "/v1/chat/completions", model: "m1", tokenId: 1,
  });
  state.chains.m1 = [provider("p1", async () => ({ id: "x" }))];
  const outcome = await runChat(req, env, fast, undefined, recorder);
  expect(outcome.kind).toBe("ok");
  expect(outcome.providerOk).toBe("p1");
  await Promise.all(c.promises);
  const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.params).toEqual(["r1", "chat", "p1", "m1", 1, "ok", expect.any(Number), null]);
});

it("records nothing when no recorder is given (console.log fallback only)", async () => {
  state.chains.m1 = [provider("p1", async () => ({ id: "x" }))];
  const outcome = await runChat(req, env, fast);
  expect(outcome.providerOk).toBe("p1");
});
```

`test/read/runner.test.ts`（该文件用 `state.jinaImpl` 等委托 mock，链中第一家是 jina）——import 区追加同上两行，describe 内追加：

```ts
it("records attempts via recorder and reports providerOk on success", async () => {
  const d1 = makeFakeD1();
  const c = makeFakeCtx();
  const recorder = new RequestRecorder(c.ctx, d1.db, {
    requestId: "r2", feature: "read", endpoint: "/v1/read", model: "", tokenId: 1,
  });
  const outcome = await runRead("https://example.com", env, fast, undefined, recorder);
  expect(outcome.kind).toBe("ok");
  expect(outcome.providerOk).toBe("jina");
  await Promise.all(c.promises);
  const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.params).toEqual(["r2", "read", "jina", "", 1, "ok", expect.any(Number), null]);
});
```

`test/embeddings/runner.test.ts`（文件已有 `provider()` 工具与 `req`/`fast` 常量）——import 区追加同上两行，`describe("runEmbeddings")` 内追加：

```ts
it("records attempts via recorder and reports providerOk on success", async () => {
  const d1 = makeFakeD1();
  const c = makeFakeCtx();
  const recorder = new RequestRecorder(c.ctx, d1.db, {
    requestId: "r3", feature: "embeddings", endpoint: "/v1/embeddings", model: "BAAI/bge-m3", tokenId: 1,
  });
  const p = provider("p1", async () => ({ data: [{ embedding: [1] }] }));
  const outcome = await runEmbeddings(req, env, p, fast, recorder);
  expect(outcome.kind).toBe("ok");
  expect(outcome.providerOk).toBe("p1");
  await Promise.all(c.promises);
  const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.params).toEqual(["r3", "embeddings", "p1", "BAAI/bge-m3", 1, "ok", expect.any(Number), null]);
});
```

`test/rerank/runner.test.ts`——import 区追加同上两行，`describe("runRerank")` 内追加：

```ts
it("records attempts via recorder and reports providerOk on success", async () => {
  const d1 = makeFakeD1();
  const c = makeFakeCtx();
  const recorder = new RequestRecorder(c.ctx, d1.db, {
    requestId: "r4", feature: "rerank", endpoint: "/v1/rerank", model: "BAAI/bge-reranker-v2-m3", tokenId: 1,
  });
  const p = provider("p1", async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }));
  const outcome = await runRerank(req, env, p, fast, recorder);
  expect(outcome.kind).toBe("ok");
  expect(outcome.providerOk).toBe("p1");
  await Promise.all(c.promises);
  const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.params).toEqual(["r4", "rerank", "p1", "BAAI/bge-reranker-v2-m3", 1, "ok", expect.any(Number), null]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/chat/runner.test.ts test/read/runner.test.ts test/embeddings/runner.test.ts test/rerank/runner.test.ts`
Expected: 新用例 FAIL（签名无 recorder 参数、outcome 无 providerOk）；旧用例 PASS。

- [ ] **Step 3: 修改四个 runner**

`src/chat/runner.ts`——import 区加：

```ts
import type { RequestRecorder } from "../telemetry";
```

`ChatOutcome` 加一个字段（`errors?: ProviderError[];` 之后）：

```ts
  /** 成功时由哪家供应商提供（kind=ok 才有），供监控记录 */
  providerOk?: string;
```

`runChat` 签名与 onAttempt、成功返回改为：

```ts
export async function runChat(
  req: ChatRequest,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
  only?: ChatProvider,
  recorder?: RequestRecorder,
): Promise<ChatOutcome> {
```

```ts
          onAttempt: (info) =>
            recorder ? recorder.attempt(provider.id, info) : logAttempt("chat", provider.id, info),
```

```ts
      return { kind: "ok", status: 200, body, providerOk: provider.id };
```

`src/read/runner.ts` 同构：import 同上；`ReadOutcome` 加 `providerOk?: string;`；签名 `runRead(url: string, env: Env, retryOverrides?: Partial<RetryOptions>, only?: ReaderProvider, recorder?: RequestRecorder)`；onAttempt 三元里 feature 字符串 `"read"`；成功返回 `{ kind: "ok", status: 200, markdown: result.markdown, providerOk: provider.id }`。

`src/embeddings/runner.ts`：`EmbeddingsOutcome` 加 `providerOk?: string;`；签名 `runEmbeddings(req: EmbeddingsRequest, env: Env, provider: EmbeddingsProvider, retryOverrides?: Partial<RetryOptions>, recorder?: RequestRecorder)`；onAttempt feature `"embeddings"`；成功返回 `{ kind: "ok", status: 200, body, providerOk: provider.id }`。

`src/rerank/runner.ts`：同 embeddings，feature `"rerank"`。

- [ ] **Step 4: 运行确认通过 + 全量验收**

Run: `npx vitest run test/chat/runner.test.ts test/read/runner.test.ts test/embeddings/runner.test.ts test/rerank/runner.test.ts` → 全 PASS。
Run: `npm run typecheck && npm test` → 全绿（index.ts 此时还没传 recorder，走 console.log 回退，行为不变）。

- [ ] **Step 5: Commit**

```bash
git add src/chat/runner.ts src/read/runner.ts src/embeddings/runner.ts src/rerank/runner.ts test/chat/runner.test.ts test/read/runner.test.ts test/embeddings/runner.test.ts test/rerank/runner.test.ts
git commit -m "feat: wire recorder into runners and expose providerOk in outcomes"
```

---

### Task 5: index.ts 集成——ctx/waitUntil、请求级记录、401 记录

**Files:**
- Modify: `src/index.ts`（fetch 签名、withRecording、四个 handler）
- Modify: `scripts/serve.ts`（Node 备用服务补 ctx，标注 D1 限制）
- Modify: `test/index.test.ts`（全部 fetch 调用补 ctx 参数 + 新用例）

**Interfaces:**
- Consumes: Task 2 `authorize`、Task 3 `RequestRecorder`/`RecorderMeta`/`recordUnauthorized`/`Feature`、Task 4 runner 新签名。
- Produces: 最终入口形态——`fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext)`；每个业务请求恰好一行 requests、每次上游尝试一行 provider_attempts（含重试）；401 恰好一行 requests。后续任务（admin）在此基础上加路由。

- [ ] **Step 1: 在 `test/index.test.ts` 追加失败测试**

import 区追加：

```ts
import { INSERT_REQUEST_SQL } from "../src/telemetry";
import { makeFakeCtx } from "./helpers";
```

`beforeEach` 中四个 outcome 默认值各补 `providerOk`（保持既有行，仅加字段）：

```ts
  state.chatOutcome = { kind: "ok", status: 200, body: { id: "default" }, providerOk: "p-default" };
  state.readOutcome = { kind: "ok", status: 200, markdown: "# default", providerOk: "p-default" };
  state.embeddingsOutcome = { kind: "ok", status: 200, body: { data: [] }, providerOk: "p-default" };
  state.rerankOutcome = { kind: "ok", status: 200, body: { results: [] }, providerOk: "p-default" };
```

新增 describe 块（放在文件任意 describe 之后）：

```ts
describe("telemetry", () => {
  it("records one requests row per authorized call with final status and providerOk", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), envReq, c.ctx);
    expect(res.status).toBe(200);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[1]).toBe("read");
    expect(row?.params[3]).toBe("");
    expect(row?.params[4]).toBe(3);
    expect(row?.params[5]).toBe(200);
    expect(row?.params[6]).toBe("p-default");
    expect(typeof row?.params[7]).toBe("number");
  });

  it("records model for chat after body validation", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    await handler.fetch(
      post("/v1/chat/completions", { model: "m1", messages: [{ role: "user", content: "hi" }] }),
      envReq,
      c.ctx,
    );
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[1]).toBe("chat");
    expect(row?.params[2]).toBe("/v1/chat/completions");
    expect(row?.params[3]).toBe("m1");
  });

  it("records a 401 row for unauthorized calls (token_id NULL, no attempts)", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }, "wrong"), envReq, c.ctx);
    expect(res.status).toBe(401);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[4]).toBeNull();
    expect(row?.params[5]).toBe(401);
  });

  it("records a requests row for validation 400s too", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/read", { url: "not-a-url" }), envReq, c.ctx);
    expect(res.status).toBe(400);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[5]).toBe(400);
  });
});
```

同时把文件中所有既有的 `handler.fetch(req, env)` / `handler.fetch(post(...), env)` 调用补第三参 `makeFakeCtx().ctx`（逐处修改；`makeEnv()` 造的 env 照用）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/index.test.ts`
Expected: 新 telemetry 用例 FAIL（当前 fetch 不接 ctx、不记录）；既有用例若因缺 ctx 报错也属预期。

- [ ] **Step 3: 改造 `src/index.ts`**

import 区追加：

```ts
import { recordUnauthorized, RequestRecorder, type Feature, type RecorderMeta } from "./telemetry";
```

`guard` 替换为（返回 tokenId 供记录）：

```ts
interface GuardResult {
  denied: Response | null;
  tokenId: number | null;
}

async function guard(request: Request, env: WorkerEnv): Promise<GuardResult> {
  const result = await authorize(request, env.DB);
  if (result.ok) return { denied: null, tokenId: result.tokenId };
  if (result.reason === "db-error") {
    return {
      denied: json(500, {
        error: { message: "auth store unavailable", type: "server_error", code: "auth_store_error" },
      }),
      tokenId: null,
    };
  }
  return { denied: json(401, { error: { message: "unauthorized" } }), tokenId: null };
}
```

新增统一包装器（放在 guard 之后）：

```ts
interface HandlerResult {
  response: Response;
  providerOk?: string;
}

/**
 * 每个业务端点的统一外壳：鉴权 → 建 recorder → 跑 handler → finish 落一行 requests。
 * 401 也落一行；500（D1 故障）不落。handler 内解析出 model 后改写 meta.model。
 */
async function withRecording(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  pathname: string,
  feature: Feature,
  run: (recorder: RequestRecorder, meta: RecorderMeta) => Promise<HandlerResult>,
): Promise<Response> {
  const start = Date.now();
  const auth = await guard(request, env);
  if (auth.denied !== null) {
    if (auth.denied.status === 401) recordUnauthorized(ctx, env.DB, pathname);
    return auth.denied;
  }
  const meta: RecorderMeta = {
    requestId: crypto.randomUUID(),
    feature,
    endpoint: pathname,
    model: "",
    tokenId: auth.tokenId,
  };
  const recorder = new RequestRecorder(ctx, env.DB, meta);
  const { response, providerOk } = await run(recorder, meta);
  recorder.finish({ status: response.status, providerOk, elapsedMs: Date.now() - start });
  return response;
}
```

四个 handler 的签名与内部改造——以 `handleChat` 为例（其余三个同构；`guard` 调用行删除，验证分支返回值包一层，`meta.model` 赋值，runner 调用传 recorder，返回带 providerOk）：

```ts
async function handleChat(
  request: Request,
  env: WorkerEnv,
  providerParam: string | null,
  recorder: RequestRecorder,
  meta: RecorderMeta,
): Promise<HandlerResult> {
  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: ChatProvider | undefined;
  if (providerParam !== null) {
    only = getChatProviderById(providerParam);
    if (!only) {
      return {
        response: json(400, {
          error: {
            message: `unknown provider: ${providerParam}; valid providers: ${CHAT_PROVIDER_IDS.join(", ")}`,
            type: "invalid_request_error",
            code: "unknown_provider",
          },
        }),
      };
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: json(400, {
        error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
      }),
    };
  }

  const req = (body ?? {}) as Partial<ChatRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return {
      response: json(400, {
        error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
      }),
    };
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return {
      response: json(400, {
        error: { message: "messages must be a non-empty array", type: "invalid_request_error", code: "invalid_messages" },
      }),
    };
  }
  if (req.stream === true) {
    return {
      response: json(400, {
        error: { message: "streaming is not supported", type: "invalid_request_error", code: "stream_not_supported" },
      }),
    };
  }
  meta.model = req.model;

  const outcome = await runChat(req as ChatRequest, env, undefined, only, recorder);
  if (outcome.kind === "all-failed") {
    return {
      response: json(502, {
        error: {
          message: "all providers failed",
          type: "upstream_error",
          code: "all_providers_failed",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  return { response: json(200, outcome.body), providerOk: outcome.providerOk };
}
```

`handleRead`：签名同构（`recorder: RequestRecorder, meta: RecorderMeta`）；`meta.model` 不赋值（read 无 model，保持 `""`）；`runRead(target, env, undefined, only, recorder)`；成功返回：

```ts
  return {
    response: new Response(outcome.markdown ?? "", {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    }),
    providerOk: outcome.providerOk,
  };
```

`handleEmbeddings`：签名同构；`meta.model = req.model;` 放在 input 校验之后、`getEmbeddingsProviderByModel` 之前；`runEmbeddings(req as EmbeddingsRequest, env, provider, undefined, recorder)`；成功 `providerOk: outcome.providerOk`。

`handleRerank`：同 handleEmbeddings，用 rerank 的类型与函数。

`fetch` 整体替换为：

```ts
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const providerParam = url.searchParams.get("provider");
      if (url.pathname === "/v1/chat/completions") {
        return withRecording(request, env, ctx, url.pathname, "chat", (recorder, meta) =>
          handleChat(request, env, providerParam, recorder, meta),
        );
      }
      if (url.pathname === "/v1/read") {
        return withRecording(request, env, ctx, url.pathname, "read", (recorder, meta) =>
          handleRead(request, env, providerParam, recorder, meta),
        );
      }
      if (url.pathname === "/v1/embeddings") {
        return withRecording(request, env, ctx, url.pathname, "embeddings", (recorder, meta) =>
          handleEmbeddings(request, env, providerParam, recorder, meta),
        );
      }
      if (url.pathname === "/v1/rerank") {
        return withRecording(request, env, ctx, url.pathname, "rerank", (recorder, meta) =>
          handleRerank(request, env, providerParam, recorder, meta),
        );
      }
    }
    return json(404, { error: { message: "not found" } });
  },
};
```

注意：index.test.ts 里 `vi.mock` 的 runner 工厂函数参数个数不必改（mock 吸收多余实参）。

- [ ] **Step 4: 兼容 `scripts/serve.ts`（Node 备用本地服务）**

serve.ts 直跑 worker handler 且没传 ctx；新代码 401 路径会调 `ctx.waitUntil` 导致崩溃。做两处最小改动：

第 10 行 `import type { Env } from "../src/env";` 改为：

```ts
import type { WorkerEnv } from "../src/env";
import type { ExecutionContext } from "@cloudflare/workers-types";
```

第 34 行 `const env = loadDevVars() as Env & Record<string, string>;` 之后追加，并把第 55 行 `worker.fetch(request, env)` 改为传 ctx：

```ts
const env = loadDevVars() as WorkerEnv & Record<string, string>;
// Node 环境没有 D1 binding：业务端点会因鉴权查不到 DB 返回 500（auth store unavailable），
// 此服务仅剩 404/管理页等非鉴权路径可用。本地联调请用 npm run dev（wrangler 提供 D1）。
const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
```

```ts
    const response = await worker.fetch(request, env, ctx);
```

同时在文件顶部用法注释（第 3-4 行）末尾追加一行：

```ts
 * 注意：D1 改造后本服务无数据库（鉴权路径 500），本地联调请优先 npm run dev。
```

- [ ] **Step 5: 运行确认通过 + 全量验收**

Run: `npx vitest run test/index.test.ts` → 全 PASS。
Run: `npm run typecheck && npm test` → 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/index.test.ts scripts/serve.ts
git commit -m "feat: record requests and 401s to D1 at gateway entry via waitUntil"
```

---

### Task 6: Admin token 管理 API（src/admin.ts）

**Files:**
- Create: `src/admin.ts`
- Create: `test/admin.test.ts`
- Modify: `src/index.ts`（加一行路由）

**Interfaces:**
- Consumes: Task 2 的 `constantTimeEquals`/`sha256Hex`、Task 1 的 `WorkerEnv`。
- Produces（Task 7 页面依赖）:
  - `handleAdminApi(request: Request, env: WorkerEnv): Promise<Response>`，覆盖 `/admin/api/tokens`（GET/POST）与 `/admin/api/tokens/:id`（PATCH/DELETE）
  - `tokenMask(prefix: string, random: string): string`（导出，规则 `prefix + random前4 + "..." + random后4`）
  - SQL 常量（测试 stub 用）：`LIST_SQL`/`INSERT_SQL`/`UPDATE_SQL`/`DELETE_SQL`
  - 错误体统一 `{error:{message, code}}`，code：`invalid_json`/`empty_token`/`random_too_short`/`duplicate_token`/`invalid_enabled`/`token_not_found`

- [ ] **Step 1: 写失败测试 `test/admin.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { handleAdminApi, tokenMask, DELETE_SQL, INSERT_SQL, LIST_SQL, UPDATE_SQL } from "../src/admin";
import { sha256Hex } from "../src/auth";
import type { WorkerEnv } from "../src/env";
import { makeFakeD1 } from "./helpers";

const ADMIN = "admin-secret";

function makeEnv(fake = makeFakeD1(), adminToken = ADMIN): WorkerEnv {
  return { DB: fake.db, ADMIN_TOKEN: adminToken } as WorkerEnv;
}

function req(method: string, path: string, body?: unknown, token = ADMIN): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init = { method, headers, body: JSON.stringify(body) };
  }
  return new Request(`https://gw.example${path}`, init);
}

describe("admin auth", () => {
  it("returns 404 for everything when ADMIN_TOKEN is unset", async () => {
    const fake = makeFakeD1();
    const env = makeEnv(fake, undefined);
    const res = await handleAdminApi(req("GET", "/admin/api/tokens"), env);
    expect(res.status).toBe(404);
    expect(fake.statements).toHaveLength(0);
  });

  it("returns 401 for missing or wrong bearer", async () => {
    const noHeader = new Request("https://gw.example/admin/api/tokens");
    expect((await handleAdminApi(noHeader, makeEnv())).status).toBe(401);
    expect((await handleAdminApi(req("GET", "/admin/api/tokens", undefined, "wrong"), makeEnv())).status).toBe(401);
  });
});

describe("tokenMask", () => {
  it("keeps the full prefix and masks the random part", () => {
    expect(tokenMask("sk_", "abcd1234wxyz")).toBe("sk_abcd...wxyz");
    expect(tokenMask("infility_agent_", "abcd1234wxyz")).toBe("infility_agent_abcd...wxyz");
    expect(tokenMask("", "abcd1234wxyz")).toBe("abcd...wxyz");
  });
});

describe("GET /admin/api/tokens", () => {
  it("lists tokens without ever exposing hash or full token", async () => {
    const fake = makeFakeD1();
    fake.setRows(LIST_SQL, [
      { id: 1, label: "a", token_mask: "sk_abcd...wxyz", enabled: 1, created_at: "2026-08-19T00:00:00.000Z" },
    ]);
    const res = await handleAdminApi(req("GET", "/admin/api/tokens"), makeEnv(fake));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tokens: unknown[] };
    expect(data.tokens).toHaveLength(1);
    const body = JSON.stringify(data);
    expect(body).not.toContain("token_hash");
    expect(body).not.toContain("abcd1234wxyz");
  });
});

describe("POST /admin/api/tokens", () => {
  it("creates a token, stores hash+mask, returns full token exactly once", async () => {
    const fake = makeFakeD1();
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abcd1234wxyz", label: "test" }),
      makeEnv(fake),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: number; token: string; token_mask: string };
    expect(data).toEqual({ id: 1, token: "sk_abcd1234wxyz", token_mask: "sk_abcd...wxyz" });
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.params).toEqual([
      await sha256Hex("sk_abcd1234wxyz"),
      "sk_",
      "sk_abcd...wxyz",
      "test",
    ]);
  });

  it("rejects random shorter than 8 chars with 400", async () => {
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abc" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: "random part must be at least 8 characters", code: "random_too_short" },
    });
  });

  it("rejects empty prefix+random with 400", async () => {
    const res = await handleAdminApi(req("POST", "/admin/api/tokens", {}), makeEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: "prefix and random cannot both be empty", code: "empty_token" },
    });
  });

  it("maps UNIQUE violations to 409", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(INSERT_SQL, "UNIQUE constraint failed: tokens.token_hash");
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abcd1234wxyz" }),
      makeEnv(fake),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { message: "token already exists", code: "duplicate_token" },
    });
  });

  it("maps other D1 failures to 500", async () => {
    const fake = makeFakeD1();
    fake.failOnSubstring(INSERT_SQL);
    const res = await handleAdminApi(
      req("POST", "/admin/api/tokens", { prefix: "sk_", random: "abcd1234wxyz" }),
      makeEnv(fake),
    );
    expect(res.status).toBe(500);
  });
});

describe("PATCH /admin/api/tokens/:id", () => {
  it("toggles enabled", async () => {
    const fake = makeFakeD1();
    const res = await handleAdminApi(req("PATCH", "/admin/api/tokens/5", { enabled: false }), makeEnv(fake));
    expect(res.status).toBe(200);
    expect(fake.statements[0]?.sql).toBe(UPDATE_SQL);
    expect(fake.statements[0]?.params).toEqual([0, 5]);
  });

  it("rejects non-boolean enabled with 400", async () => {
    const res = await handleAdminApi(req("PATCH", "/admin/api/tokens/5", { enabled: "yes" }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the id does not exist (changes=0)", async () => {
    const fake = makeFakeD1();
    fake.setRunMeta(UPDATE_SQL, { changes: 0, last_row_id: 0 });
    const res = await handleAdminApi(req("PATCH", "/admin/api/tokens/99", { enabled: true }), makeEnv(fake));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/api/tokens/:id", () => {
  it("deletes and returns ok", async () => {
    const fake = makeFakeD1();
    const res = await handleAdminApi(req("DELETE", "/admin/api/tokens/5"), makeEnv(fake));
    expect(res.status).toBe(200);
    expect(fake.statements[0]?.params).toEqual([5]);
  });

  it("returns 404 when the id does not exist", async () => {
    const fake = makeFakeD1();
    fake.setRunMeta(DELETE_SQL, { changes: 0, last_row_id: 0 });
    const res = await handleAdminApi(req("DELETE", "/admin/api/tokens/99"), makeEnv(fake));
    expect(res.status).toBe(404);
  });
});

describe("unknown admin paths", () => {
  it("returns 404", async () => {
    const res = await handleAdminApi(req("GET", "/admin/api/nope"), makeEnv());
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/admin.test.ts`
Expected: FAIL——`../src/admin` 不存在。

- [ ] **Step 3: 实现 `src/admin.ts`**

```ts
import { constantTimeEquals, sha256Hex } from "./auth";
import type { WorkerEnv } from "./env";

export const LIST_SQL = "SELECT id, label, token_mask, enabled, created_at FROM tokens ORDER BY id";
export const INSERT_SQL =
  "INSERT INTO tokens (token_hash, token_prefix, token_mask, label) VALUES (?, ?, ?, ?)";
export const UPDATE_SQL = "UPDATE tokens SET enabled = ? WHERE id = ?";
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
    const result = await env.DB.prepare(LIST_SQL).all<{
      id: number;
      label: string;
      token_mask: string;
      enabled: number;
      created_at: string;
    }>();
    return json(200, { tokens: result.results });
  }

  if (path === "/admin/api/tokens" && request.method === "POST") {
    const body = (await readJsonBody(request)) as
      | { prefix?: unknown; random?: unknown; label?: unknown }
      | undefined;
    const parsed = body ?? {};
    const prefix = typeof parsed.prefix === "string" ? parsed.prefix.trim() : "";
    const random = typeof parsed.random === "string" ? parsed.random.trim() : "";
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
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
      const result = await env.DB.prepare(INSERT_SQL).bind(tokenHash, prefix, mask, label).run();
      lastRowId = result.meta.last_row_id ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed")) {
        return json(409, { error: { message: "token already exists", code: "duplicate_token" } });
      }
      return json(500, { error: { message: "database error", code: "db_error" } });
    }
    // 完整 token 仅此一次返回，此后库里只剩哈希与掩码。
    return json(201, { id: lastRowId, token, token_mask: mask });
  }

  const idMatch = path.match(/^\/admin\/api\/tokens\/(\d+)$/);
  if (idMatch && idMatch[1] !== undefined) {
    const id = Number(idMatch[1]);

    if (request.method === "PATCH") {
      const body = (await readJsonBody(request)) as { enabled?: unknown } | undefined;
      const enabled = (body ?? {}).enabled;
      if (typeof enabled !== "boolean") {
        return json(400, { error: { message: "enabled must be a boolean", code: "invalid_enabled" } });
      }
      const result = await env.DB.prepare(UPDATE_SQL).bind(enabled ? 1 : 0, id).run();
      if ((result.meta.changes ?? 0) === 0) {
        return json(404, { error: { message: "token not found", code: "token_not_found" } });
      }
      return json(200, { ok: true });
    }

    if (request.method === "DELETE") {
      const result = await env.DB.prepare(DELETE_SQL).bind(id).run();
      if ((result.meta.changes ?? 0) === 0) {
        return json(404, { error: { message: "token not found", code: "token_not_found" } });
      }
      return json(200, { ok: true });
    }
  }

  return json(404, { error: { message: "not found" } });
}
```

- [ ] **Step 4: `src/index.ts` 接入路由**

import 区追加：

```ts
import { handleAdminApi } from "./admin";
```

`fetch` 中，`if (request.method === "POST") {` 之前插入：

```ts
    if (url.pathname.startsWith("/admin/api/")) return handleAdminApi(request, env);
```

- [ ] **Step 5: 运行确认通过 + 全量验收**

Run: `npx vitest run test/admin.test.ts` → 全 PASS。
Run: `npm run typecheck && npm test` → 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/admin.ts src/index.ts test/admin.test.ts
git commit -m "feat: add admin token management API backed by D1"
```

---

### Task 7: `/admin` 管理页面（静态登录壳 + 操作页）

**Files:**
- Create: `src/admin-page.ts`
- Modify: `src/index.ts`（加 GET /admin 路由）
- Modify: `test/index.test.ts`（追加 admin 页面与路由用例）

**Interfaces:**
- Consumes: Task 6 的 `/admin/api/*`。
- Produces: `ADMIN_PAGE_HTML: string`（完整 HTML 文档，无外部依赖）；`GET /admin` 返回 200 `text/html`（不鉴权、无数据、noindex）。

- [ ] **Step 1: 在 `test/index.test.ts` 追加失败测试**

```ts
describe("admin page routing", () => {
  it("serves the static shell for GET /admin without auth", async () => {
    const res = await handler.fetch(
      new Request("https://gw.example/admin"),
      makeEnv(),
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("admin_token");   // 登录逻辑存在
    expect(html).toContain("noindex");       // 不被搜索引擎收录
    expect(html).not.toContain("sk-");       // 壳内不含任何数据/密钥
  });

  it("routes /admin/api/* through handleAdminApi (401 without bearer)", async () => {
    const envAdmin = makeEnv();
    envAdmin.ADMIN_TOKEN = "admin-secret";
    const res = await handler.fetch(
      new Request("https://gw.example/admin/api/tokens"),
      envAdmin,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for GET on unknown admin path", async () => {
    const res = await handler.fetch(
      new Request("https://gw.example/admin/nope"),
      makeEnv(),
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/index.test.ts`
Expected: 新用例 FAIL（`/admin` 返回 404）。

- [ ] **Step 3: 写 `src/admin-page.ts`**

页面 JS 全程用字符串拼接（不用模板字面量），保证整个文件能作为单个 TS template literal 常量导出且无 `${` 转义问题：

```ts
/**
 * /admin 管理页：静态登录壳 + token 列表/新建/启停/删除。
 * 无外部 JS/CSS 依赖；本字符串不含任何密钥或数据，数据全部经 /admin/api/*（Bearer ADMIN_TOKEN）获取。
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Providers 管理后台</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; color: #1f2933; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; font-size: 14px; }
  button { margin: 2px 4px 2px 0; padding: 4px 10px; cursor: pointer; }
  input { padding: 4px 6px; }
  code { background: #f3f4f6; padding: 1px 4px; }
  .muted { color: #6b7280; font-size: 12px; }
  #token-result { background: #f3f4f6; padding: 8px; font-family: monospace; word-break: break-all; margin-top: 8px; }
</style>
</head>
<body>
<h2>Providers 管理后台</h2>
<div id="login">
  <p>输入管理密钥（ADMIN_TOKEN）：</p>
  <input type="password" id="admin-key" style="width: 320px">
  <button id="btn-login">登录</button>
</div>
<div id="main" hidden>
  <h3>Token 列表</h3>
  <table id="tokens"><thead><tr><th>ID</th><th>名称</th><th>掩码</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody></tbody></table>
  <h3>新建 Token</h3>
  <p>前缀：<input id="prefix" placeholder="如 sk_ 或 infility_agent_（可留空）" style="width: 280px"></p>
  <p>随机串：<input id="random" style="width: 380px"> <button id="btn-gen">生成</button></p>
  <p>名称：<input id="label" placeholder="用途备注" style="width: 280px"></p>
  <button id="btn-create">创建</button>
  <p class="muted">完整 token 仅创建后展示一次，请立即复制保存。随机串可手改（至少 8 位）；复用旧 token 时前缀留空、随机串贴完整旧值。</p>
  <div id="token-result" hidden></div>
</div>
<script>
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function hdr() {
  return { "authorization": "Bearer " + sessionStorage.getItem("admin_token"), "content-type": "application/json" };
}
function showLogin() {
  document.getElementById("login").hidden = false;
  document.getElementById("main").hidden = true;
}
function api(path, options) {
  return fetch(path, Object.assign({}, options, { headers: hdr() })).then(function (res) {
    if (res.status === 401) { sessionStorage.removeItem("admin_token"); showLogin(); throw new Error("unauthorized"); }
    return res;
  });
}
function render(data) {
  var tb = document.querySelector("#tokens tbody");
  tb.innerHTML = "";
  (data.tokens || []).forEach(function (t) {
    var tr = document.createElement("tr");
    tr.innerHTML = "<td>" + t.id + "</td><td>" + esc(t.label) + "</td><td><code>" + esc(t.token_mask) + "</code></td>" +
      "<td>" + (t.enabled ? "启用" : "禁用") + "</td><td>" + esc(t.created_at) + "</td>" +
      "<td><button data-act='toggle' data-id='" + t.id + "' data-next='" + (t.enabled ? 0 : 1) + "'>" + (t.enabled ? "禁用" : "启用") + "</button>" +
      "<button data-act='del' data-id='" + t.id + "'>删除</button></td>";
    tb.appendChild(tr);
  });
}
function load() {
  return api("/admin/api/tokens").then(function (res) {
    if (!res.ok) { showLogin(); return; }
    document.getElementById("login").hidden = true;
    document.getElementById("main").hidden = false;
    return res.json().then(render);
  }).catch(function () {});
}
document.getElementById("btn-login").addEventListener("click", function () {
  var v = document.getElementById("admin-key").value.trim();
  if (!v) return;
  sessionStorage.setItem("admin_token", v);
  load();
});
document.getElementById("btn-gen").addEventListener("click", function () {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  var out = "";
  for (var i = 0; i < bytes.length; i++) out += chars.charAt(bytes[i] % chars.length);
  document.getElementById("random").value = out;
});
document.getElementById("btn-create").addEventListener("click", function () {
  var body = {
    prefix: document.getElementById("prefix").value,
    random: document.getElementById("random").value,
    label: document.getElementById("label").value,
  };
  api("/admin/api/tokens", { method: "POST", body: JSON.stringify(body) }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) { alert((data.error && data.error.message) || "创建失败"); return; }
      var box = document.getElementById("token-result");
      box.hidden = false;
      box.textContent = "完整 token（仅此一次，请立即复制）：" + data.token;
      load();
    });
  }).catch(function () {});
});
document.getElementById("tokens").addEventListener("click", function (ev) {
  var btn = ev.target;
  if (!btn || btn.tagName !== "BUTTON") return;
  var id = btn.getAttribute("data-id");
  if (btn.getAttribute("data-act") === "toggle") {
    var next = btn.getAttribute("data-next") === "1";
    api("/admin/api/tokens/" + id, { method: "PATCH", body: JSON.stringify({ enabled: next }) })
      .then(load).catch(function () {});
  } else if (btn.getAttribute("data-act") === "del") {
    if (!confirm("确认删除该 token？")) return;
    api("/admin/api/tokens/" + id, { method: "DELETE" }).then(load).catch(function () {});
  }
});
load();
</script>
</body>
</html>
`;
```

- [ ] **Step 4: `src/index.ts` 接入页面路由**

import 区追加：

```ts
import { ADMIN_PAGE_HTML } from "./admin-page";
```

`fetch` 中，`if (url.pathname.startsWith("/admin/api/"))` 之前插入：

```ts
    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(ADMIN_PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
```

- [ ] **Step 5: 运行确认通过 + 全量验收**

Run: `npx vitest run test/index.test.ts` → 全 PASS。
Run: `npm run typecheck && npm test` → 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/admin-page.ts src/index.ts test/index.test.ts
git commit -m "feat: add /admin management page with token generation"
```

---

### Task 8: 文档、配置模板与最终验收

**Files:**
- Create: `docs/monitoring-sql.md`
- Modify: `.dev.vars.example`
- Modify: `README.md`
- Modify: `docs/API.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 前七个任务的全部成品。
- Produces: 无代码接口；交付文档与上线 Runbook。

- [ ] **Step 1: 写 `docs/monitoring-sql.md`**

````markdown
# 监控数据 SQL 查询指南

网关把每次调用（`requests`）与每次供应商上游尝试（`provider_attempts`，含重试）写入 D1（库 `providers_db`）。本文给出常用统计查询。

## 如何执行

```bash
# 生产（--remote）
npx wrangler d1 execute providers_db --remote --command "<下面任一条 SQL>"

# 本地（--local）
npx wrangler d1 execute providers_db --local --command "<SQL>"
```

或 Cloudflare 控制台 → Workers & Pages → providers-workers → D1 → providers_db → Console 直接粘贴 SQL。

时间列均为 ISO 字符串（毫秒精度）。查询里用 `datetime(col)` 与 `datetime('now','-N days')` 比较，避免 `T`/空格分隔符的字典序陷阱。

## 表速览

- `requests`：每次网关调用一行。`feature`(chat/read/embeddings/rerank)、`endpoint`、`model`、`token_id`(关联 tokens，删除后为 NULL)、`status`(最终响应码；401 表示鉴权失败)、`provider_ok`(成功供应商；全失败/非业务失败为 NULL)、`elapsed_ms`。
- `provider_attempts`：每次上游尝试一行（含重试）。`provider`、`model`、`attempt`(第几次)、`result`(ok/retry/fatal)、`elapsed_ms`、`error`。
- `tokens`：token 登记表。`token_mask` 用于人工比对；完整 token 与哈希不入查询结果。

## 查询集

**1. 各供应商近 7 天成功率与平均耗时（判断关停/更换的核心依据）**

```sql
SELECT provider,
       COUNT(*) AS attempts,
       SUM(result = 'ok') AS ok,
       ROUND(100.0 * SUM(result = 'ok') / COUNT(*), 1) AS ok_pct,
       ROUND(AVG(elapsed_ms)) AS avg_ms
FROM provider_attempts
WHERE datetime(created_at) >= datetime('now', '-7 days')
GROUP BY provider
ORDER BY ok_pct;
```

**2. 按天看某家供应商的成败趋势**（把 `agnes` 换成 provider id）

```sql
SELECT date(created_at) AS day,
       COUNT(*) AS attempts,
       SUM(result = 'ok') AS ok,
       SUM(result = 'retry') AS retried
FROM provider_attempts
WHERE provider = 'agnes'
  AND datetime(created_at) >= datetime('now', '-14 days')
GROUP BY day
ORDER BY day;
```

**3. 某家供应商的失败明细**（错误信息 Top）

```sql
SELECT error, COUNT(*) AS n
FROM provider_attempts
WHERE provider = 'agnes'
  AND result != 'ok'
  AND datetime(created_at) >= datetime('now', '-7 days')
GROUP BY error
ORDER BY n DESC
LIMIT 20;
```

**4. 某家最近 50 条失败尝试的时间线**

```sql
SELECT created_at, model, attempt, result, elapsed_ms, error
FROM provider_attempts
WHERE provider = 'agnes' AND result != 'ok'
  AND datetime(created_at) >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 50;
```

**5. 端到端全失败（502）的请求**

```sql
SELECT created_at, feature, model, status
FROM requests
WHERE status = 502
  AND datetime(created_at) >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 50;
```

**6. 上面某条 502 请求的供应商逐家明细**（把 `<request_id>` 换成上一条查不到就先 `SELECT request_id FROM requests WHERE status=502 ORDER BY id DESC LIMIT 1;`）

```sql
SELECT provider, attempt, result, elapsed_ms, error
FROM provider_attempts
WHERE request_id = '<request_id>'
ORDER BY id;
```

**7. 成功请求由哪家兜底**（看降级链实际命中分布）

```sql
SELECT feature, provider_ok, COUNT(*) AS n
FROM requests
WHERE status = 200
  AND datetime(created_at) >= datetime('now', '-7 days')
GROUP BY feature, provider_ok
ORDER BY feature, n DESC;
```

**8. 按 token 的调用量与成功率**

```sql
SELECT COALESCE(t.label, '(已删除/401)') AS label,
       COALESCE(t.token_mask, '-') AS mask,
       COUNT(*) AS calls,
       SUM(r.status = 200) AS ok
FROM requests r
LEFT JOIN tokens t ON r.token_id = t.id
WHERE datetime(r.created_at) >= datetime('now', '-30 days')
GROUP BY t.id
ORDER BY calls DESC;
```

**9. 401 探测记录**（有没有人在乱试 token）

```sql
SELECT created_at, endpoint, model
FROM requests
WHERE status = 401
  AND datetime(created_at) >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 100;
```

**10. 各逻辑 model 的调用量**（近 30 天）

```sql
SELECT feature, model, COUNT(*) AS calls, ROUND(AVG(elapsed_ms)) AS avg_ms
FROM requests
WHERE datetime(created_at) >= datetime('now', '-30 days')
GROUP BY feature, model
ORDER BY calls DESC;
```
````

- [ ] **Step 2: 更新 `.dev.vars.example`**

`AUTH_TOKENS=change-me-token-1,change-me-token-2` 一行及其后空行替换为：

```
# 管理后台密钥（保护 /admin/api/*）。本地 D1 初始化：npx wrangler d1 migrations apply providers_db --local
# 网关调用 token 不在此配置——启动后经 /admin 后台管理（存 D1）。
ADMIN_TOKEN=change-me-admin
```

- [ ] **Step 3: 更新 `README.md`**

3a. 端点表（`| POST | /v1/rerank |` 行之后）追加一行：

```markdown
| GET | `/admin` | 管理后台（token 管理：新建/启停/删除，自动生成随机串）。数据接口 `/admin/api/*` 需 `ADMIN_TOKEN`。 |
```

3b. `所有端点要求 \`Authorization: Bearer <token>\`。` 一行替换为：

```markdown
业务端点要求 `Authorization: Bearer <token>`；token 由管理员在 `/admin` 后台创建与停用（存 D1，无需重新部署）。
```

3c. 本地开发代码块替换为（补 D1 初始化）：

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入真实密钥（ADMIN_TOKEN 必填，供应商 key 可选）
npx wrangler d1 migrations apply providers_db --local   # 初始化本地 D1（tokens/requests/provider_attempts）
npm run dev                      # wrangler dev 本地启动
```

3d. 配置表中 `| \`AUTH_TOKENS\` | 网关访问 token，逗号分隔可多个 |` 一行替换为：

```markdown
| `ADMIN_TOKEN` | 管理后台密钥（保护 `/admin/api/*`）；网关调用 token 在 `/admin` 后台管理（存 D1） |
```

- [ ] **Step 4: 更新 `docs/API.md`**

4a. 接口一览表（`/v1/read` 行之后）追加：

```markdown
| GET | `/admin` | 管理后台页面（token 管理）。数据接口 `/admin/api/*` 需 `ADMIN_TOKEN`，非业务端点。 | — |
```

4b. 通用约定"鉴权"段 `token 由管理员下发（服务端可配置多个）` 替换为 `token 由管理员经 /admin 后台创建与停用（存 D1，管理密钥为 ADMIN_TOKEN secret）`。

4c. 相关文档列表追加一行：

```markdown
- `docs/monitoring-sql.md`：监控数据（requests / provider_attempts）常用 SQL 统计查询
```

- [ ] **Step 5: 更新 `AGENTS.md` 与 `CLAUDE.md`**

5a. 常用命令代码块中 `npm run deploy` 行之后追加两行（保持在代码块内）：

```bash
npx wrangler d1 migrations apply providers_db --local    # 本地 D1 迁移（生产用 --remote，见部署 Runbook）
npx wrangler d1 execute providers_db --remote --command "SELECT ..."   # 查监控数据（查询集见 docs/monitoring-sql.md）
```

5b. 目录结构 `log.ts` 行之后插入：

```
  telemetry.ts    # RequestRecorder：requests/provider_attempts 落库（waitUntil 异步，失败仅 warn）
  admin.ts        # /admin/api/* token 管理 API（Bearer ADMIN_TOKEN）
  admin-page.ts   # /admin 静态管理页（无数据登录壳）
migrations/       # D1 schema 迁移（wrangler d1 migrations）
```

5c. `src/index.ts        # 入口：路由 + 鉴权守卫 + 错误矩阵（401/400/404/502）` 一行替换为：

```
  index.ts        # 入口：路由（业务 + /admin）+ 鉴权（D1 tokens 表）+ 错误矩阵（401/400/404/500/502）+ 请求级监控
```

5d. `env.ts           # Env 类型（AUTH_TOKENS 必填，供应商 key 可选）` 一行替换为：

```
  env.ts          # Env 类型（ADMIN_TOKEN 可选，供应商 key 可选）+ WorkerEnv（含 DB: D1Database binding）
```

5e. "密钥与环境变量"小节整体替换为：

```markdown
## 密钥与环境变量

- 本地：`.dev.vars`（已 gitignore，**严禁提交真实密钥**），模板见 `.dev.vars.example`。
- 生产：`wrangler secret put <KEY>`。**生产所有变量一律用 secret**（勿在 dashboard 配明文 var——git push 自动部署会清掉未声明的明文 var）。
- 网关调用 token：存 D1 `tokens` 表（SHA-256 哈希），经 `/admin` 后台管理（登录密钥 `ADMIN_TOKEN` secret）；禁用立即生效，无需重新部署。
- `ADMIN_TOKEN` 未配置时 `/admin` 与 `/admin/api/*` 返回 404，业务接口不受影响。
- 供应商 key 一律可选：缺 key 的供应商按 `NonRetryableError` 快速跳过换下家，不要改成启动时报错。
```

5f. "测试约定"小节末尾追加一段：

```markdown
- D1 相关测试用 `test/helpers.ts` 的 `makeFakeD1()`（可 stub rows/run meta/注入故障）与 `makeFakeCtx()`（收集 waitUntil promise），不依赖真实 D1。
```

5g. `CLAUDE.md` 常用命令里 `npx tsx scripts/serve.ts` 一行替换为：

```bash
npx tsx scripts/serve.ts      # 备用本地服务（D1 改造后鉴权路径不可用，本地联调优先 npm run dev）
```

5h. `CLAUDE.md` 架构小节的请求流一行替换为：

```markdown
请求流：`src/index.ts` 路由（业务端点 + `/admin` 管理后台）→ auth 校验（`src/auth.ts`，Bearer token 的 SHA-256 查 D1 `tokens` 表，库 `providers_db`）→ runner。每次调用与每次上游尝试经 `src/telemetry.ts`（RequestRecorder，waitUntil 异步）落 D1 监控，查询集见 `docs/monitoring-sql.md`。
```

- [ ] **Step 6: 全量验收**

Run: `npm run typecheck && npm test`
Expected: 全绿。

Run: `git status --short`
Expected: 只有本任务涉及的文件变更。

- [ ] **Step 7: 本地端到端冒烟（可选但推荐；供应商 key 未配也能验鉴权与 admin 全链路）**

```bash
npx wrangler d1 migrations apply providers_db --local
npm run dev &
curl -s http://localhost:8787/admin -o /dev/null -w "%{http_code}\n"          # 期望 200
curl -s -X POST http://localhost:8787/admin/api/tokens \
  -H "Authorization: Bearer change-me-admin" -H "Content-Type: application/json" \
  -d '{"prefix":"sk_","random":"localtest123456","label":"smoke"}'            # 期望 201，返回完整 token sk_localtest123456
curl -s -X POST http://localhost:8787/v1/read \
  -H "Authorization: Bearer sk_localtest123456" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' -o /dev/null -w "%{http_code}\n"          # 期望 502（缺上游 key 全失败；鉴权已过即非 401）
curl -s -X POST http://localhost:8787/v1/read \
  -H "Authorization: Bearer wrong-token" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' -o /dev/null -w "%{http_code}\n"          # 期望 401
npx wrangler d1 execute providers_db --local --command "SELECT feature,status,token_id FROM requests ORDER BY id DESC LIMIT 3"
# 期望倒序：status=401（token_id NULL）、status=502（token_id=1）
npx wrangler d1 execute providers_db --local --command "SELECT provider,result,error FROM provider_attempts ORDER BY id DESC LIMIT 5"
# 期望看到 read 链各家失败行（缺 key 的 NonRetryableError）
```

冒烟完杀掉 wrangler dev：Windows 下须杀整棵进程树（cmd→node wrangler→workerd），杀后 `netstat -ano | grep 8787` 验证无 LISTENING。

- [ ] **Step 8: Commit**

```bash
git add docs/monitoring-sql.md .dev.vars.example README.md docs/API.md AGENTS.md
git commit -m "docs: add monitoring SQL guide and document D1-based auth and admin"
```

---

## 生产上线 Runbook（用户确认后执行，工程师不自行操作）

顺序敏感：**步骤 4 之前业务不受影响；步骤 4 之后、步骤 5 完成前业务接口全部 401（D1 无 token），属预期，尽快录入。**

```bash
# 1. 应用 schema 到生产 D1
npx wrangler d1 migrations apply providers_db --remote

# 2. 配置管理密钥
npx wrangler secret put ADMIN_TOKEN        # 粘贴一个强随机值

# 3. （此时生产还在跑旧代码 + 旧 AUTH_TOKENS，业务正常）——确认无误后：
git push                                    # 触发自动部署新代码

# 4. 浏览器打开 https://api.oklapzlj.com/admin ，登录 ADMIN_TOKEN：
#    a. 手工录入现有 token：前缀留空、随机串贴完整旧 token、label 如 "migrated"；
#       或直接创建新 token（sk_ 前缀 + 生成随机串）发给调用方替换。
#    b. 复制返回的完整 token 备用（仅显示一次）。

# 5. 验证：
curl -s -X POST https://api.oklapzlj.com/v1/read \
  -H "Authorization: Bearer <上一步的 token>" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' -w "\n%{http_code}\n"          # 期望 200（或上游问题 502，但鉴权已过、非 401）
npx wrangler d1 execute providers_db --remote --command "SELECT feature,status,provider_ok FROM requests ORDER BY id DESC LIMIT 5"
# 期望看到刚才的请求行；401 行（步骤4之前用旧 token 调用的记录）也应存在

# 6. 确认业务正常后，废弃旧 secret：
npx wrangler secret delete AUTH_TOKENS
```

回滚预案：若新代码异常，`git revert <合并提交> && git push` 即回旧版（旧版继续读 AUTH_TOKENS secret——因此步骤 6 务必在观察 24h 后再执行；期间两套并存不冲突，新代码不读 AUTH_TOKENS）。
