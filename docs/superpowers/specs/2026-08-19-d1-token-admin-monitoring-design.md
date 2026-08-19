# D1 接入：token 管理 + 供应商监控 设计文档

- 日期：2026-08-19
- 状态：已确认（方案 A：D1 一库全包），待实施
- 范围：providers-workers（Cloudflare Workers 多供应商聚合网关）

## 1. 背景与目标

现状两个痛点：

1. **鉴权 token 靠 `AUTH_TOKENS` secret**，增删 token 必须走 wrangler CLI，无界面、无元数据（分不清哪个 token 是谁在用）。
2. **供应商执行情况只有 console.log**（Workers Logs，不持久化），无法回答"某家最近错误率多高、报什么错"这类问题，判断关停/更换供应商缺数据。

目标：

1. Token 迁入 Cloudflare D1，Worker 内置极简管理页（增删、启用/禁用、自动生成）。
2. 供应商执行监控持久化到 D1：每次上游尝试一行（含重试），外加每次网关调用一行请求级日志。只入库，不开发统计界面——使用方自行写 SQL 查询（配套 `docs/monitoring-sql.md` 查询指南）。
3. 一次性切换：AUTH_TOKENS 迁入 D1 后废弃 env 鉴权路径。

## 2. 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 存储选型 | D1 单库（binding `DB`），不引入 KV/Analytics Engine |
| 管理后台形态 | Worker 内置极简 HTML 单页，无外部依赖 |
| Token 属性 | 哈希 + label + 启用开关 + 创建时间 + 掩码；**无过期时间** |
| 监控粒度 | 每次上游尝试一行（含重试），另加 requests 表记请求维度 |
| 数据消费 | 只入库；用户自写 SQL（wrangler d1 execute / dashboard） |
| 数据保留 | 不做自动清理，空间紧张时手动 DELETE |
| 迁移方式 | 一次性切到 D1，废弃 `env.AUTH_TOKENS`；无 seed 脚本，token 由用户上线后在后台手工录入 |
| 自锁保护 | **不做**"最后一个 enabled token 禁止删/禁"防护（持有 ADMIN_TOKEN 随时可新建 token，防护无实际意义） |

## 3. 数据模型

D1 数据库已由用户手工创建：`database_name = "providers_db"`，`database_id = "3e4ea628-5362-4c9d-97f5-7a788230ada4"`。

Schema 用 wrangler 原生 migrations 管理，首个迁移 `migrations/0001_init.sql`：

```sql
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,          -- SHA-256 hex(完整 token)
  token_prefix TEXT NOT NULL DEFAULT '',    -- 手填前缀，如 "sk_"、"infility_agent_"
  token_mask TEXT NOT NULL,                 -- prefix + 随机段前4 + "..." + 随机段后4
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,                 -- crypto.randomUUID()，关联 attempts
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  feature TEXT NOT NULL,                    -- chat | read | embeddings | rerank
  endpoint TEXT NOT NULL,                   -- 如 /v1/chat/completions
  model TEXT NOT NULL DEFAULT '',           -- 请求体里的逻辑 model
  token_id INTEGER REFERENCES tokens(id) ON DELETE SET NULL,
  status INTEGER NOT NULL,                  -- 最终响应状态码
  provider_ok TEXT,                         -- 成功时的供应商 id；全失败/非业务失败为 NULL
  elapsed_ms INTEGER                        -- 网关端到端耗时
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
  attempt INTEGER NOT NULL,                 -- 第几次尝试，从 1 起
  result TEXT NOT NULL CHECK (result IN ('ok','retry','fatal')),  -- 沿用 AttemptInfo 语义
  elapsed_ms INTEGER NOT NULL,
  error TEXT                                -- 失败时错误消息；成功为 NULL
);
CREATE INDEX idx_attempts_provider_created ON provider_attempts(provider, created_at);
CREATE INDEX idx_attempts_request ON provider_attempts(request_id);
```

说明：

- 完整 token 明文永不落库。掩码在创建时由服务端从 (prefix, random) 推导：`prefix + random.slice(0,4) + "..." + random.slice(-4)`。
- `requests.token_id` 用 `ON DELETE SET NULL`：token 删除后历史请求仍可查，JOIN 不到时显示 NULL。
- 401 未授权的调用也记一行 requests（`token_id` NULL、status 401、无 attempts），用于观察乱试 token 的行为。

## 4. 鉴权改造（src/auth.ts）

业务接口鉴权从"读 env CSV 逐个 SHA-256 常量时间比较"改为：

1. 解析 `Authorization: Bearer <token>`；
2. 对传入 token 算 SHA-256 hex；
3. `SELECT id FROM tokens WHERE token_hash = ? AND enabled = 1`；
4. 命中 → 放行并返回 `tokenId`（供 requests 表记录）；未命中（不存在/被禁用）→ 401。

行为约定：

- 返回值为判别联合：`{ ok: true; tokenId: number } | { ok: false; reason: "missing" | "invalid" } | { ok: false; reason: "db-error" }`。index.ts 将 `db-error` 映射为 500（区别于 401"凭证无效"），fail-closed。
- 逐 token 常量时间比较不再需要（哈希查库无非对称时序面）；现有 `constantTimeEquals` 保留，转用于 ADMIN_TOKEN 校验。
- `env.AUTH_TOKENS` 从 `Env` 类型与 index.ts 移除。
- 不加 isolate 级缓存：每次请求一次 D1 查询，量级下延迟可忽略；换来禁用立即生效。

## 5. 监控埋点（src/telemetry.ts）

新增 `RequestRecorder`，每次网关调用在 index.ts 入口创建：

```
new RequestRecorder(ctx, db, { requestId, feature, endpoint, model, tokenId })
```

- `attempt(provider, info: AttemptInfo)`：先保留现有 console.log 格式不变，再异步落一行 provider_attempts。
- `finish({ status, providerOk, elapsedMs })`：响应前调用，落一行 requests。
- 所有 D1 写入包进 `ctx.waitUntil()`：不增加请求延迟；写失败仅 `console.warn`，绝不影响业务响应。
- 401 路径无 recorder，用模块级 `recordUnauthorized(ctx, db, endpoint)` 记一行：`feature` 按 endpoint 路径前缀推导（`/v1/chat*`→chat、`/v1/embeddings*`→embeddings、`/v1/rerank*`→rerank、其余→read），`model` 留空串（鉴权失败时未解析 body）。

Runner 接线（chat/read/embeddings/rerank 四处一致）：

- runner 函数各加一个 `recorder` 参数（放最后一个参数，可选；chat 现有 `retryOverrides`/`only` 参数位置不动，签名细节以实施计划为准，不构成行为约束）；`onAttempt` 从 `(info) => logAttempt(feature, provider.id, info)` 改为 `(info) => recorder.attempt(provider.id, info)`（console.log 逻辑移入 recorder 内，日志行为不变）。
- 各 runner 的 outcome 类型增加 `providerOk?: string`（成功供应商 id），供 finish 记录。chat 的 `ChatOutcome`、read/embeddings/rerank 的对应类型同步扩展。
- index.ts 在入口 `Date.now()` 计时，按 outcome 调 finish。

## 6. 管理后台（src/admin.ts，自包含单文件）

### 路由

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/admin` | GET | 内联 HTML 单页（无外部 JS/CSS 依赖） |
| `/admin/api/tokens` | GET | 列表：id / label / token_mask / enabled / created_at（永不返回哈希或完整 token） |
| `/admin/api/tokens` | POST | 创建。body `{ prefix, random, label }`；服务端拼 `token = prefix + random`、算哈希、推掩码；成功 201 返回 `{ id, token_mask, token }`——**完整 token 仅此一次返回** |
| `/admin/api/tokens/:id` | PATCH | body `{ enabled: boolean }` |
| `/admin/api/tokens/:id` | DELETE | 硬删；requests.token_id 置 NULL |

### 鉴权与安全

- `/admin/api/*` 全部要求 `Authorization: Bearer <ADMIN_TOKEN>`（复用常量时间比较）。`GET /admin` 返回的是不含任何数据的静态登录壳，不鉴权——浏览器地址栏导航无法携带 Bearer 头；壳内加 noindex，登录后才经 fetch 带 Bearer 取数。ADMIN_TOKEN 未配置时 `/admin` 与 `/admin/api/*` 一律 404，业务接口不受影响。
- `/admin*` 路由在 index.ts 中先于业务鉴权判断。
- 无 cookie、无 CSRF 面；页面登录框收 ADMIN_TOKEN 存 sessionStorage，fetch 带 Bearer。
- 输入校验：`prefix + random` 去空白后非空，`random` 长度 ≥ 8（否则掩码失去意义，返回 400）；除此之外不做字符集/强度限制（自己的后台，编辑自由）。UNIQUE 冲突返回 409。

### 页面交互（按用户确认稿）

- 两个独立编辑框：**前缀框**（手填，如 `sk_`）+ **随机串框**（点"生成"按钮用 `crypto.getRandomValues` 填入 32 位 `[A-Za-z0-9]` 随机串，**可手改**——粘贴旧 token 时前缀留空、随机框贴完整旧值即可复用旧 token）。
- 保存后完整 token 仅创建响应展示一次，提示复制保存。
- 列表支持：新建、删除、启用/禁用切换。

## 7. 工程接入

### wrangler.toml

```toml
[[d1_databases]]
binding = "DB"
database_name = "providers_db"
database_id = "3e4ea628-5362-4c9d-97f5-7a788230ada4"
migrations_dir = "migrations"
```

### Env（src/env.ts）

- 加 `DB: D1Database`（必填）、`ADMIN_TOKEN?: string`（可选）。
- 移除 `AUTH_TOKENS: string`。供应商 key 声明与 index signature 不变。

### .dev.vars.example

移除 `AUTH_TOKENS`，新增 `ADMIN_TOKEN=`（本地开发用；本地 DB 用 `wrangler d1 migrations apply providers_db --local` 初始化）。

## 8. 测试策略

vitest，D1 binding 全程 mock（假实现 D1Database 的 prepare/first/run 链式接口），不引入真网络、不依赖真 D1：

- **鉴权**：命中（返回 tokenId）/ 不存在 / 被禁用 → 401；D1 抛错 → 500。
- **埋点**：attempts 行字段与时机（每次 onAttempt 一行）、requests 行字段（status/provider_ok/elapsed_ms）、写失败仅 warn 不影响主流程、401 也落一行。
- **admin API**：未带/错 ADMIN_TOKEN → 401（未配置 → 404）；CRUD 全路径；`random` 过短 → 400；哈希冲突 → 409；列表不泄露哈希与完整 token。
- **回归**：现有 runner/provider 测试补传 mock recorder 后全绿。

验收：`npm run typecheck && npm test` 全绿。

## 9. 上线顺序（git push 自动部署，顺序敏感）

1. ~~手工创建 D1~~ 已完成（providers_db）。
2. `npx wrangler d1 migrations apply providers_db --remote`。
3. `npx wrangler secret put ADMIN_TOKEN`。
4. git push 上线新代码。**注意：此步之后、token 录入之前，业务接口全部 401（D1 无可用 token），属预期，尽快走下一步。**
5. 浏览器打开 `https://api.oklapzlj.com/admin`，登录后手工录入现有 token（前缀留空、随机框贴完整旧 token，label 如 "migrated"），或直接发放新 token 给调用方。
6. 验证：带 token 调各业务接口 200；admin 列表正确；禁用一个测试 token 后调用 401；`wrangler d1 execute providers_db --remote --command "SELECT ..."` 确认 requests/provider_attempts 有数据。
7. `npx wrangler secret delete AUTH_TOKENS`，README 配置表同步更新。

## 10. 交付物清单

- `migrations/0001_init.sql`
- `src/auth.ts`（重写）、`src/telemetry.ts`（新增）、`src/admin.ts`（新增，自包含）
- 四个 runner + `src/index.ts`、`src/env.ts`、`wrangler.toml`、`.dev.vars.example` 更新
- `docs/monitoring-sql.md`：常用统计查询集——各家近 N 天成功率/错误 Top/平均耗时、指定 provider 失败明细、端到端全失败请求、按 token 用量、401 探测记录；每条附 wrangler d1 execute 一行命令；README 与 docs/API.md 目录挂链接
- 测试补齐

## 11. 非目标（明确不做）

- 日志自动清理（Cron/TTL）
- 统计界面或统计 API
- token 过期时间、isolate 级鉴权缓存
- 供应商链/降级逻辑的任何改动
- KV / Analytics Engine（写配额真不够时再议迁移日志）
