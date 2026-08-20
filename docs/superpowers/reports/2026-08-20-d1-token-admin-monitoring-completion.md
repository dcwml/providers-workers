# D1 Token 管理 + 供应商监控 — 实施完成报告

**日期：** 2026-08-20
**状态：** 已合并本地 master（`9643eb0..996e837`，12 个功能提交 + 5 个前置文档提交），**未推送、未上线**。typecheck 干净，191/191 测试全绿（终审审查者独立复跑确认）。

## 交付内容

| 模块 | 文件 | 说明 |
|---|---|---|
| D1 schema | `migrations/0001_init.sql` | tokens / requests / provider_attempts 三表 + 5 索引，本地已应用验证 |
| 鉴权 | `src/auth.ts` | SHA-256 哈希查 D1 tokens 表；D1 故障 → 500 `auth_store_error`；`constantTimeEquals` 保留给 ADMIN_TOKEN |
| 埋点 | `src/telemetry.ts` | RequestRecorder：每次网关调用一行 requests（含 401），每次上游尝试一行 provider_attempts（含重试）；全部经 `ctx.waitUntil` 异步写，失败仅 warn |
| runner 接入 | `src/{chat,read,embeddings,rerank}/runner.ts` | 可选末参 `recorder`，ok 结果带 `providerOk` |
| 入口整合 | `src/index.ts` | withRecording 包装：鉴权→记录→执行→finish；fetch 签名加 ctx |
| 管理 API | `src/admin.ts` | `/admin/api/*`（Bearer ADMIN_TOKEN，未配 404）；创建/列表/启停/删除；409 重复、404 不存在；完整 token 仅创建时返回一次 |
| 管理页 | `src/admin-page.ts` | `/admin` 无鉴权静态壳（noindex、无数据），前缀+随机串两个独立编辑框，32 位 [A-Za-z0-9] 生成 |
| 文档 | `docs/monitoring-sql.md` 等 | 10 条统计 SQL；README/API.md/AGENTS.md/CLAUDE.md 同步更新 |

## 生产上线 Runbook（摘自计划文档尾部，需你确认后逐步执行）

1. `npx wrangler d1 migrations apply providers_db --remote`
2. `npx wrangler secret put ADMIN_TOKEN`（高熵值）
3. `git push`（触发自动部署）
4. 到 `https://api.oklapzlj.com/admin` 用 ADMIN_TOKEN 录入业务 token —— **此窗口内所有业务请求 401，属预期**
5. 验证新 token 调通 + `wrangler d1 execute --remote` 能查到 requests 行
6. 观察 ~24h 后 `npx wrangler secret delete AUTH_TOKENS`（旧代码读它、新代码不读，共存安全；删除前可 `git revert` 回滚）

**零停机替代方案（终审建议，可选）：** 第 3 步前用 `npx wrangler d1 execute providers_db --remote` 直接 INSERT 旧 token 的 SHA-256 哈希，部署即无缝切换，无 401 窗口。当初你决定不做 seed 工具、手工后台录入——若接受零停机方案，执行时告诉我，我帮你算哈希并生成 INSERT 语句。
**注意：** 旧 token 若是弱熵值，无盐 SHA-256 哈希在库泄露时可被字典攻击；建议优先签发新的 32 位生成 token 而非迁移旧弱 token。

## 遗留小项（终审判定可延后，均不影响合并）

admin 页对非 JSON 500 静默失败、telemetry 行唯一性未显式断言、页面随机串有轻微取模偏移（~190 位熵无实际影响）、admin 401/404 响应体无 code 字段、fake D1 无 batch/raw。完整清单见终审记录。

## 过程备注

- 计划中 3 处代码缺陷在执行中被发现并修正：`{ DB: ... }` 字面量需 `as WorkerEnv` 断言（Env 索引签名冲突）、telemetry 测试 params[2] 断言列错位、admin 测试 makeEnv 默认参数吞掉 undefined。均同步回改了计划文档。
- 冒烟验证在本地完成：创建 token → 200/502/401 各路径 + D1 落库行核对无误。
