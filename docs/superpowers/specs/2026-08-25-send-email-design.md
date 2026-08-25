# send-email 端点设计（email 模块 / SendGrid + SMTP）

- 日期：2026-08-25
- 状态：已批准（决策点四项定案；用户已提供 SMTP=腾讯企业邮箱 exmail（smtp.exmail.qq.com:465/SSL，info@infility.cn）并配好 `SENDGRID_API_KEY`；验收测试收件邮箱待用户提供，不阻塞实施与本地验证）
- 范围：新增 `POST /v1/send-email` 及 `src/email/` 模块，首版 provider = SendGrid + exmail（腾讯企业邮箱 SMTP）；不含生产部署（secret 配置与 git push 另行安排）

## 1. 背景与目标

providers 网关新增邮件发送端点。需求要点（用户原话归纳）：参数 subject / text / html / to / cc / bcc；不支持 attachment；text 与 html 二选一、都传不报错以 html 为准；多 provider 且 `?provider=` 与其他接口一致；provider 可能是 SMTP（host/port/ssl/username 写死、password 走环境变量）也可能是 SendGrid 等 HTTP API（api key 走环境变量）；to > cc > bcc 跨组去重；收件人支持裸地址与 `Name <addr>` 两种格式，格式非法报错。

## 2. 需求定案（已确认决策）

| 决策点 | 结论 |
|---|---|
| 重试语义 | 单次尝试 + 安全降级：每家恰好发一次；「确定没发出去」的失败自动换下家；「不确定发没发出去」（投递状态未知）立即中止不降级——邮件不幂等，宁可让调用方人工重发，不冒重复发信风险 |
| 缺省行为 | 未带 `?provider=` 走默认链（缺 key 的家自动跳过），与 `/v1/read` 一致；带 `?provider=` 只跑单家不降级 |
| from 来源 | provider 内置发件人（文件里写死，支持 `Name <addr>`），请求体不接受 from 字段 |
| 首版 provider | SendGrid（HTTP API）+ exmail（腾讯企业邮箱 SMTP） |
| 链顺序 | SMTP（exmail，自有邮箱）→ SendGrid 兜底（自有域名信誉优先）；已随 SMTP 服务商输入定案 |

## 3. 组件设计

### 3.1 目录结构

```
src/email/
  types.ts          # ParsedAddress / PreparedMail / EmailProvider
  address.ts        # 地址解析 + to>cc>bcc 去重（纯函数）
  runner.ts         # EMAIL_CHAIN / EMAIL_PROVIDER_IDS / runEmail
  smtp-client.ts    # SMTP 协议传输库（基于 cloudflare:sockets）
  providers/sendgrid.ts
  providers/exmail.ts        # 腾讯企业邮箱 SMTP（smtp.exmail.qq.com:465/SSL）
```

`index.ts` 加路由与 `handleEmail`（与 handleRead 同款模式）；`errors.ts` 加 `DeliveryUncertainError`；`telemetry.ts` 的 `Feature` 加 `"email"`。每家 provider 仍是一个自包含文件（项目铁律不变；`smtp-client.ts` 定位是协议传输库——类比 fetch 之于 HTTP，不是供应商适配层）。

### 3.2 `src/email/types.ts`

```ts
interface ParsedAddress { name?: string; address: string }   // name 空时省略
interface PreparedMail {
  subject: string;
  bodyKind: "text" | "html";                                  // 都传时已按 html 归一
  body: string;
  to: ParsedAddress[]; cc: ParsedAddress[]; bcc: ParsedAddress[];  // 已完成去重
}
interface EmailProvider {
  id: string;
  from: ParsedAddress;                                        // 内置发件人
  send(mail: PreparedMail, env: Env, signal: AbortSignal): Promise<{ messageId?: string }>;
}
```

### 3.3 `src/email/address.ts`（纯函数）

`parseAddress(input: string): ParsedAddress | null`：

1. 整串 trim；空串 → null
2. 含 `<`：必须恰好一对尖括号且 trim 后以 `>` 结尾——name = `<` 前内容（trim，允许空），address = 尖括号内（trim）；name 含控制字符（`\x00-\x1F`、`\x7F`）或 `<`/`>` → null（防邮件头注入）
3. 不含 `<`：整串视为裸地址，name 为空
4. address 必须匹配：`/^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/`（本地部实用字符集；域名至少两段、段内禁连字符起止）——实用正则子集，不追求全量 RFC 5322（带引号的极端形式不支持）
5. 其余一律 null（多个 `<`、`>` 不在末尾、地址不匹配等）

`prepareRecipients(to, cc, bcc)`：比较键 = `address.toLowerCase()`；组内去重保留首次出现（保留其名称写法）；to 出现过的地址从 cc、bcc 移除；cc 出现过的从 bcc 移除；去重后 cc/bcc 允许为空数组。

### 3.4 `src/email/runner.ts`

- `EMAIL_CHAIN: readonly EmailProvider[]`（默认 SMTP → SendGrid）；`EMAIL_PROVIDER_IDS`、`getEmailProviderById` 同 read 模式导出
- `runEmail(mail, env, only?, recorder?)`：逐家串行，每家 `withRetry(..., { maxAttempts: 1, onAttempt: recorder 接线 })`——复用 withRetry 仅取其 onAttempt 遥测接线，语义 = 恰好一次尝试（`DEFAULT_RETRY` 不适用）；每次尝试在闭包内新建 `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`
- 错误分流：`DeliveryUncertainError` → 立即中止整链（后面的家不再尝试）；其它错误 → 收集进 `errors[]` 换下家
- outcome：`{kind:"ok", status:200, body, providerOk, messageId?}` / `{kind:"uncertain", status:502, errors}` / `{kind:"all-failed", status:502, errors}`

### 3.5 `src/email/smtp-client.ts`

单入口 `sendSmtpMail(options, signal, connectFn?)`；options = `{host, port, secure: "ssl"|"starttls", username, password, from, to, cc, bcc, subject, bodyKind, body}`。`connectFn` 依赖注入（默认动态 `import("cloudflare:sockets")` 的 `connect`），测试注入脚本化 fake socket，零真实网络。

会话流程（应答读取需处理多行续行：`250-` 续、`250 ` 止）：

1. 连接：465 = `secureTransport:"on"` 直连 TLS；587 = `"starttls"` 明文连入 → 读 220 问候 → EHLO → 发 STARTTLS → 220 → `socket.startTls()` → 重新 EHLO。**升级成功前绝发 AUTH**（凭证不过明文）
2. EHLO 应答解析 AUTH 机制：优先 AUTH PLAIN（`base64(\0user\0pass)`）；无 PLAIN 有 LOGIN → AUTH LOGIN（两步 334 提示）；两者皆无 → `NonRetryableError`
3. `MAIL FROM:<from.address>` → `RCPT TO:` 逐个发 to+cc+bcc 全部（bcc 只进 RCPT 不进邮件头）；任一 RCPT 应答非 250 → `NonRetryableError`（消息含被拒地址与应答码）
4. `DATA` → 354 → 写 MIME 消息（见下）→ `.` → 最终应答 250
5. `QUIT` 后关闭；QUIT 阶段任何失败忽略，不影响已成功的结果

MIME 消息：`From`（name 非 ASCII 时 encoded-word）/ `To` / `Cc`（非空才写，bcc 不写）/ `Subject`（非 ASCII 时 `=?UTF-8?B?...?=`）/ `Date`（RFC 5322）/ `Message-ID`（`<uuid@发件域名>` 自生成）/ `MIME-Version: 1.0` / `Content-Type: text/plain|text/html; charset=utf-8` / `Content-Transfer-Encoding: base64`（正文整体 base64、76 字符折行、SMTP dot-stuffing）。

阶段失败分类（**精化**：相对口头设计「354 后任何失败均 uncertain」收紧为——收到明确应答即确定）：

- DATA 收到 354 **之前**的任何失败（连接/TLS/EHLO/AUTH/MAIL/RCPT/DATA 命令被拒/超时/断连）= 确定未发出 → 网络错 `classifyNetworkError`、应答码异常 `NonRetryableError`（分类仅影响错误消息，runner 不重试）
- 354 之后**等待最终应答**时超时/断连 = 投递状态未知 → `DeliveryUncertainError`
- 354 之后**收到**最终应答：250 = 成功；非 250 = 上游明确拒收、确定未发出 → `NonRetryableError`

整个会话受传入 `signal` 约束（超时中断按上述阶段规则归类）。

### 3.6 `src/email/providers/sendgrid.ts`

- `id: "sendgrid"`；`BASE_URL = "https://api.sendgrid.com/v3"`；`ENV_KEY = "SENDGRID_API_KEY"`（用户已配好值）；`from` 写死为 `{ name: "Infility", address: "info@infility.cn" }`（默认与 exmail 同地址；**前提**：该地址或 infility.cn 域名已在 SendGrid 后台完成发件认证——SendGrid 对未认证地址直接 403，实施时本地联调即验证，未认证则用户补认证或改用已认证地址，provider 文件一行改）
- `send()`：缺 key → `NonRetryableError`（消息保持 `${ENV_KEY} is not configured` 格式）；`POST /mail/send`，Bearer 头，body：`personalizations: [{to, cc?, bcc?}]`（ParsedAddress 映射 `{email, name?}`）、`from: {email, name?}`、`subject`、`content: [{type: "text/plain"|"text/html", value: body}]`（bodyKind 决定，单 content 项）
- 结果分类：fetch 抛错（含超时 abort）→ `DeliveryUncertainError`（请求可能已达上游被受理）；收到任何 HTTP 响应 = 确定状态：2xx → `{messageId: X-Message-Id 头 ?? undefined}`（202 响应体为空，不解析 JSON）；非 2xx → `classifyHttpStatus`（429/5xx 标 Retryable 仅影响消息文案，runner 单次不重试）

### 3.7 `src/email/providers/exmail.ts`（腾讯企业邮箱）

- 自包含写死：`HOST = "smtp.exmail.qq.com"`、`PORT = 465`、`secure = "ssl"`（隐式 TLS）、`USERNAME = "info@infility.cn"`、`from = { name: "Infility", address: "info@infility.cn" }`（显示名可后续一行改）；`ENV_KEY = "EXMAIL_SMTP_PASSWORD"`
- 密码说明：邮箱后台若开启「安全登录/客户端专用密码」，`EXMAIL_SMTP_PASSWORD` 须填客户端专用密码而非登录密码（spike 阶段即验证）
- `send()`：缺 key → `NonRetryableError` 快速跳过；组装 options 调 `sendSmtpMail(options, signal)`，结果与错误原样透传

### 3.8 `index.ts`：路由与 handleEmail

`POST /v1/send-email` → `withRecording(..., "email", ...)`。校验顺序（全部 400 OpenAI 风格错误体）：

| 校验 | 规则 | code |
|---|---|---|
| `?provider=` | 未知值 400，message 列合法 id（与现有四端点一致） | `unknown_provider` |
| JSON 解析 | 失败 400；解析后 `?? {}` 守卫 | `invalid_json` |
| `subject` | 必填非空字符串 | `missing_subject` |
| `subject` | 不含控制字符（**精化**：防邮件头注入） | `invalid_subject` |
| `text`/`html` | 至少一个非空字符串；html 非空优先，否则 text；均为空/缺失 → 400（都传不报错） | `missing_body` |
| `to` | 必填；string 或非空 string[]（单字符串视为单元素数组、不拆逗号，同 embeddings `input` 先例） | `invalid_recipients` |
| `cc`/`bcc` | 可选，规则同 to，缺省空数组 | `invalid_recipients` |
| 逐项地址 | 任一项非字符串或 `parseAddress` 返回 null → 400，message 指明位置与原值（如 `cc[2]: invalid address "xxx"`） | `invalid_recipients` |

`meta.model` 置空（同 read）。成功 200：`{"accepted": true, "provider": "<id>", "message_id": "<可选>"}`（message_id 仅上游返回时才有）。

### 3.9 `src/errors.ts` / `src/env.ts` / `src/telemetry.ts`

- errors.ts：`export class DeliveryUncertainError extends Error`（`name: "DeliveryUncertainError"`），不动既有类与函数
- env.ts：`Env` 增 `SENDGRID_API_KEY?: string` 与 `EXMAIL_SMTP_PASSWORD?: string`（可选，与既有 key 声明一致）
- telemetry.ts：`Feature` 联合类型加 `"email"`；`featureFromEndpoint` 显式加 `if (endpoint.startsWith("/v1/send-email")) return "email"`（不加会把该端点 401 误归 `"read"` 兜底）

## 4. 错误矩阵与响应

| 状态 | 场景 | code |
|---|---|---|
| 400 | 同第 3.8 节校验表 | `unknown_provider` / `invalid_json` / `missing_subject` / `invalid_subject` / `missing_body` / `invalid_recipients` |
| 401 | 网关鉴权失败（外壳既有） | — |
| 500 | D1 故障（外壳既有） | `auth_store_error` |
| 502 | 全链安全失败（每家都确定未发出） | `all_providers_failed`，附 `provider_errors` |
| 502 | 投递状态未知、已中止降级 | `delivery_uncertain`，message 说明「上游可能已受理，为避免重复发送未降级」，附 `provider_errors` |
| 404 | 其余路径（既有） | — |

监控：`requests` 每请求一行（feature=email，model 空）；`provider_attempts` 每家一行（attempt=1，result=ok|fatal）；uncertain 中止那家记 fatal 后无后续行。

## 5. SMTP-on-Workers 可行性 spike（实施第一步，产出报告）

查证依据（2026-08-25，Cloudflare 官方 TCP sockets 文档）：出站 TCP 仅明确禁 25 端口，465/587 未列受限；`secureTransport: "on"|"starttls"` 与 `socket.startTls()` 均受支持。按项目铁律（能力必须实测），SMTP provider 写码前先 spike：

- 本仓 wrangler 为 4.x，`wrangler dev --remote` 已移除；spike 采用**临时独立 worker**：单文件脚本（connect → 问候 → EHLO → STARTTLS/TLS → EHLO → AUTH 的握手转录器），`npx wrangler deploy <spike脚本> --name providers-smtp-spike` 部署到用户账号，凭证经 `wrangler secret put` 配到该临时 worker，curl 其 URL 取握手转录
- SMTP 连接发起于 CF 边缘，本机代理/DNS 问题不影响握手路径；本机 wrangler 登录/部署命令仍需 `HTTPS_PROXY=http://127.0.0.1:7890`（本机已知）
- 判定：465 与 587 任一模式握手+AUTH 通过 → 按 3.7 实施（`secure` 取通过的模式，465 优先）；均不通 → 试服务商备用端口（如 2525）；全不通 → 回用户重议（SMTP 砍掉、HTTP-only）
- 收尾：`npx wrangler delete --name providers-smtp-spike`；结论写入 `docs/superpowers/reports/2026-08-25-smtp-spike.md`
- 最终验收 = 生产真发一封测试邮件并确认送达（收件邮箱待用户提供）

## 6. 测试计划（vitest，上游/socket 全部 mock，无真实网络）

- `test/email/address.test.ts`：合法两式（裸/带名/中文名/名含空格）、非法矩阵（空串、缺@、域一段、段连字符起止、多个尖括号、`>` 非末尾、name 含控制字符、name 含 `<>`）、trim 行为；去重矩阵（组内重复、to→cc/bcc 移除、cc→bcc 移除、大小写不敏感键、保留首个含名写法、跨组同名不同名）
- `test/email/smtp-client.test.ts`：脚本化 fake socket——465 直连 TLS 与 587 STARTTLS 升级（断言升级后才发 AUTH、升级后重新 EHLO）、AUTH PLAIN 优先/LOGIN 回退/皆无报错、EHLO 多行续行、RCPT 逐个（含 bcc）、MIME 头（bcc 不在头、Subject encoded-word、Message-ID、Content-Type 随 bodyKind）、base64+折行+dot-stuffing、250 最终应答成功、QUIT 失败不影响成功、各阶段失败分类（354 前超时=可降级错误、354 后超时=DeliveryUncertainError、354 后非 250=NonRetryableError）
- `test/email/providers.test.ts`：sendgrid 缺 key / fetch 抛错→DeliveryUncertainError / 2xx→messageId 取 X-Message-Id（缺失则无）/ 4xx / 5xx / body 构造断言（personalizations、from、content 单项、bodyKind 映射）；smtp provider 缺 key / options 装配（host/port/from/收件人展开）/ 错误透传（注入 fake connect）
- `test/email/runner.test.ts`：默认链顺序、`only` 单家、safe 失败降级到下家、DeliveryUncertainError 中止（断言后续家未被调用）、全失败聚合、每家恰一次尝试（maxAttempts=1 语义）
- `test/index.test.ts` 加 `describe("send-email")`：第 3.8 节校验表全矩阵 + html 优先 + text 单独 + 成功 200（含 provider/message_id）
- `test/telemetry.test.ts`：`/v1/send-email` 401 归类为 email、attempts 落库行

## 7. 文档改动

- 新建 `docs/API-email.md`（对齐 API-read.md 风格）：字段表、两种地址格式与去重规则说明、`?provider=`、错误码表、curl 示例、生产现状小节
- `docs/API.md` 索引加行；`README.md` 端点表 + 配置表两行（SENDGRID_API_KEY、SMTP 密码变量）；`.dev.vars.example` 同步两行；`docs/monitoring-sql.md` 补 email 查询示例
- `AGENTS.md`：目录结构加 `email/` 行，核心约定补「邮件」小节（链、单次尝试+安全降级语义、uncertain 规则、与 withRetry 的 maxAttempts:1 用法）

## 8. 环境变量清单（命名本 spec 冻结）

provider 文件内 `ENV_KEY` 常量 + `.dev.vars.example` + README 配置表三处同步；本地写 `.dev.vars`（gitignored，严禁提交），生产一律 `wrangler secret put`（勿配明文 var）。

| 变量 | 用途 | 状态 |
|---|---|---|
| `SENDGRID_API_KEY` | sendgrid provider | 已定名，用户已配好 `.dev.vars` |
| `EXMAIL_SMTP_PASSWORD` | exmail provider 密码（SMTP 密码或客户端专用密码） | 已定名，待用户填 `.dev.vars` |

`.dev.vars.example` 已随本 spec 同步补两行（2026-08-25 提交）。

注：vitest 全 mock 不需要真实凭证；真实值用于 spike、`npm run dev` 联调与生产 secret。

## 9. 实施顺序

1. SMTP spike（第 5 节）→ 报告（目标 exmail smtp.exmail.qq.com:465，587 仅作备测）
2. `errors.ts` 加 `DeliveryUncertainError`；`env.ts` 加 key 声明
3. `email/address.ts` + `test/email/address.test.ts`（TDD）
4. `email/smtp-client.ts` + `test/email/smtp-client.test.ts`（TDD，fake socket）
5. `email/providers/sendgrid.ts` + `exmail.ts` + `test/email/providers.test.ts`
6. `email/runner.ts` + `test/email/runner.test.ts`
7. `index.ts` 路由 + `telemetry.ts` + `test/index.test.ts` / `test/telemetry.test.ts` 增补
8. 文档（第 7 节）+ `.dev.vars.example`（已先行同步，届时核对）
9. `npm run typecheck && npm test` 全绿
10. `npm run dev` 本地真发一封 → 生产部署后真发一封（验收，收件邮箱待用户提供）

## 10. 待用户输入（实施前置）

1. ~~SMTP 服务商~~ 已提供：腾讯企业邮箱 exmail（smtp.exmail.qq.com:465/SSL，账号 info@infility.cn）；密码由用户自行写入 `.dev.vars` 的 `EXMAIL_SMTP_PASSWORD`
2. ~~SendGrid API key~~ 用户已配好 `.dev.vars`；发件认证前提见 3.6 节（默认 from=info@infility.cn，未认证则补认证或改用已认证地址）
3. ~~链顺序确认~~ 默认 exmail → sendgrid，已定案
4. 验收用测试收件邮箱：待提供，不阻塞实施（本地联调可临时发到用户自己任一邮箱）

## 11. 范围外（记录不实施）

attachment、reply-to、自定义邮件头、收件人数量上限、限流、bounce/退信处理、SendGrid 域名认证配置、模板/批量营销邮件、`cloudflare:sockets` 类型声明若缺失时的最小 d.ts 补齐以外的任何类型基建。
