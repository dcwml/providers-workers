# send-email 端点完成报告（2026-08-27）

计划：`docs/superpowers/plans/2026-08-25-send-email.md`；spec：`docs/superpowers/specs/2026-08-25-send-email-design.md`。执行方式：子代理驱动（每任务 implementer → spec compliance review → code quality review）。

## 交付内容

- **`POST /v1/send-email`**：text/html 二选一（html 优先）、`to`/`cc`/`bcc` 收件人解析 + 跨组去重（to > cc > bcc，忽略大小写，保留首次名称写法）、发件人内置、无附件。
- **email 模块**（`src/email/`）：`types.ts` / `address.ts`（解析+去重纯函数）/ `smtp-client.ts`（SMTP 协议库，基于 `cloudflare:sockets`，connect 依赖注入）/ `runner.ts`（`EMAIL_CHAIN = [exmail, sendgrid]`）/ `providers/`（exmail、sendgrid 自包含）。
- **不幂等安全语义**：每家恰好一次（`withRetry maxAttempts:1` 仅取遥测接线）；「确定没发出」才降级；`DeliveryUncertainError`（SMTP DATA 354 后超时/断连、SendGrid fetch 抛错）立即中止降级返回 502 `delivery_uncertain`，防重复发信。
- **基础设施**：`DeliveryUncertainError` 错误类、`env.ts` 新增两个可选 key、遥测 `feature='email'` 落 `requests`/`provider_attempts`。
- **文档**：新建 `docs/API-email.md`；更新 `docs/API.md`、`README.md`、`docs/monitoring-sql.md`（查询 11：邮件发送量）、`AGENTS.md`（模块约定）。

## 计划执行摘要

| 任务 | 内容 | commit | 评审 |
| --- | --- | --- | --- |
| 1 | SMTP spike | **跳过**（EXMAIL_SMTP_PASSWORD 未配置，用户指示） | — |
| 2 | DeliveryUncertainError + env + telemetry | 1f2a817 | 双审通过 |
| 3 | address.ts | 22cff31 | 双审通过 |
| 4 | smtp-client.ts | aa587f2 + 34dcf0a | spec ✅；quality 修复后 APPROVED |
| 5 | providers（exmail/sendgrid） | e0af223 | 双审通过 |
| 6 | runner | 1035b1e | 双审通过 |
| 7 | 入口路由 + handleEmail | d7ccb39 | 双审通过 |
| 8 | 文档全套 | 49e4edd | spec 7/7 + 一致性 10/10 |
| 9 | 冒烟 + 本报告 | 本次 commit | — |

Task 1 跳过的影响：465/SSL 与 AUTH PLAIN/LOGIN 顺序未经真实 exmail 环境验证；`smtp-client` 按 spec 默认 AUTH PLAIN 优先 + LOGIN 回退实现（全 mock 覆盖两条路径）。配置密码后建议先 `?provider=exmail` 隔离验证再放开。

## 验收证据

- `npm run typecheck`：干净。
- `npm test`：**272/272 全绿**（基线 224 → 272）。email 贡献：address 15 + smtp-client 15 + providers 9 + runner 10 = 49，另入口路由 14 用例在 `test/index.test.ts`。
- 本地冒烟（`wrangler dev` + 本地 D1，D1 迁移幂等应用后建冒烟 token）：
  - 401：无 token → `{"error":{"message":"unauthorized"}}` ✅
  - 400 矩阵：`invalid_json` / `missing_subject` / `missing_body` / `invalid_recipients`（`to[0]: invalid address "bad address"`）/ `unknown_provider`（列出 `exmail, sendgrid`）✅
  - **200 真发**：合法请求 → exmail 缺密码快速跳过 → **sendgrid 真发成功** `{"accepted":true,"provider":"sendgrid","message_id":"BkfD_WdPSMGnwwnc8xPzYA"}`（收件地址为保留域占位地址 `a@example.com`，不触达真实用户）✅
  - 遥测落库：`provider_attempts` 中 `exmail=fatal("EXMAIL_SMTP_PASSWORD is not configured")`、`sendgrid=ok` ✅
- SMTP 真发冒烟：按用户指示跳过（密码未配置）；降级路径已由上述 exmail 缺 key 实证。

## 已知边界 / deferred minors（不阻塞，记录于 progress.md）

- Task 2：errors.test.ts 可补 `toBeInstanceOf(DeliveryUncertainError)` 断言。
- Task 5：providers.test.ts 可用 `vi.resetAllMocks()` 替 `clearAllMocks`；补 `init.signal === signal` 断言。
- Task 6：遥测 result 枚举无法区分 `uncertain`（需动家族 AttemptInfo，fix-later）；可补 uncertain 遥测/降级链 2 行落库断言。
- Task 7：bcc 解析失败分支、html 空串回落边界未测；收件人数量/长度无上限（全仓统一限额议题）。
- Task 8：API-email.md uncertain 场景列举为典型非穷举。
- 既有 fix-later（retry.ts 死代码等）未动，见 2026-08-14 完成报告。

## 生产部署待办（本计划范围外）

1. 生产未部署（计划明确不含 `git push`/部署）。
2. 生产 secret 缺 `SENDGRID_API_KEY`：`npx wrangler secret put SENDGRID_API_KEY`（wrangler 命令需 `HTTPS_PROXY=http://127.0.0.1:7890`）。
3. `EXMAIL_SMTP_PASSWORD` 可选：未配置时 exmail 自动跳过、sendgrid 兜底；配置后建议先 `?provider=exmail` 隔离验证（含发件认证是否需要提醒用户在 SendGrid/腾讯企业邮箱后台配置）。
4. 部署后按 `docs/API-email.md`「生产现状」节复核。
