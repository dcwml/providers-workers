# AGENTS.md - Providers 项目工作手册

多供应商聚合网关：Cloudflare Workers 上的 OpenAI 兼容 chat 接口 + embeddings 接口 + rerank 接口 + 页面读取接口 + 搜索接口 + 邮件发送接口 + 天气查询接口，内置重试与供应商自动降级。本文件是修改本项目代码时必须遵守的约定。

## 常用命令

```bash
npm test            # vitest 全量（上游 HTTP 全部 mock，无真实网络）
npm run typecheck   # tsc --noEmit，必须干净
npm run probe -- <providerId>  # 实测 chat 供应商四项能力（发真实上游请求，密钥取自根目录 .dev.vars）
npm run dev         # wrangler dev 本地联调（需先配 .dev.vars）
npm run deploy      # 发布前建议先 npx wrangler deploy --dry-run
npx wrangler d1 migrations apply providers_db --local    # 本地 D1 迁移（生产用 --remote，见部署 Runbook）
npx wrangler d1 execute providers_db --remote --command "SELECT ..."   # 查监控数据（查询集见 docs/monitoring-sql.md）
```

改动后最低验收：`npm run typecheck && npm test` 全绿。

## 技术栈与运行环境

- 仅 Cloudflare Workers（**不考虑 Node.js 兼容**），原生 fetch handler，无框架、无运行时依赖。
- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`；新代码保持同等严格度，不得用 `any` 绕过。
- Worker 运行时限制要注意：无 Node API（如 `crypto.timingSafeEqual` 不可用，现有 SHA-256+XOR 常量时间比较是刻意选择，勿"改回"）。

## 目录结构

```
src/
  index.ts        # 入口：路由（业务 + /admin）+ 鉴权（D1 tokens 表）+ 错误矩阵（401/403/400/404/500/502）+ 请求级监控
  auth.ts         # 业务鉴权（token SHA-256 哈希查 D1 tokens 表，带出 scopes 接口权限）+ API_SCOPES/parseScopes/normalizeScopes + constantTimeEquals（admin.ts 校验 ADMIN_TOKEN 复用）
  config.ts       # UPSTREAM_TIMEOUT_MS=30s、DEFAULT_RETRY={3次,1s}
  env.ts          # Env 类型（ADMIN_TOKEN 可选，供应商 key 可选）+ WorkerEnv（含 DB: D1Database binding）
  errors.ts       # RetryableError/NonRetryableError/classifyHttpStatus/classifyNetworkError
  retry.ts        # withRetry：仅重试 RetryableError
  log.ts          # logAttempt：结构化尝试日志
  telemetry.ts    # RequestRecorder：requests/provider_attempts 落库（waitUntil 异步，失败仅 warn）
  admin.ts        # /admin/api/* token 管理 API（Bearer ADMIN_TOKEN），创建/编辑支持 scopes（空=不限制）
  admin-page.ts   # /admin 静态管理页（无数据登录壳）
migrations/       # D1 schema 迁移（wrangler d1 migrations）
  chat/           # types / sanitize（能力裁剪）/ chains（model→链）/ runner / providers/
  embeddings/     # types / models（model→单 provider，无链）/ runner / providers/
  rerank/         # types / models（model→单 provider，无链）/ runner / providers/
  read/           # types / runner（固定链）/ providers/（jina、tavily、firecrawl）
  search/         # types / runner（固定链）/ providers/（anysearch）
  email/          # types / address（地址解析+去重）/ runner（链）/ smtp-client（SMTP 协议库）/ providers/（exmail、sendgrid）
  weather/        # types / coords（地图链接解析 + BD-09MC/BD-09/GCJ-02→WGS-84 坐标换算）/ runner（位置解析→预报）/ providers/（open-meteo）
```

## 核心约定

### 供应商实现

- **每家供应商一个自包含文件**（`src/chat/providers/*.ts`、`src/read/providers/*.ts`、`src/embeddings/providers/*.ts`、`src/rerank/providers/*.ts`、`src/weather/providers/*.ts`）：写死 BASE_URL、上游 model、ENV_KEY，自带失败分类逻辑。这是明确的架构选择，**不要抽公共适配器、不要消除供应商间的重复**。
- chat 供应商发送请求前：先 `sanitizeRequest` 按 capabilities 裁剪（不支持的参数直接删；`json_schema` 不支持时降级 `json_object`；system 消息并入首条 user 消息），再把 `body.model` 改写为自家上游 model。
- embeddings 供应商发送请求前：按 OpenAI embeddings 标准字段白名单（input/encoding_format/dimensions/user）裁剪，`body.model` 改写为自家上游固定 model；响应 `data` 为空数组按 `NonRetryableError` 处理。
- rerank 供应商发送请求前：按 rerank 标准字段白名单（query/documents/top_n/return_documents）裁剪，`body.model` 改写为自家上游固定 model；响应 `results` 为空数组按 `NonRetryableError` 处理。
- **响应一律原样透传**：不改上游 JSON 的任何字段（包括 model）。
- 失败分类统一口径：缺 API key → `NonRetryableError`；fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`（5xx/429 可重试，其它 4xx 不可重试但仍换下家）；响应非 JSON → `RetryableError`；提取内容为空 → `NonRetryableError`。
- 每次上游尝试必须有独立 `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`（在重试闭包内新建，勿复用）。

### 供应商链

- chat：`src/chat/chains.ts` 按逻辑 model 写死链，数组顺序即降级顺序。当前 `sample-chat`/`sample-reasoning` 为**示例占位**，替换真实供应商时只改这里和 providers/。
- read：`src/read/runner.ts` 的 `READ_CHAIN` 固定 jina → tavily → firecrawl，勿改顺序除非明确要求。
- embeddings：`src/embeddings/models.ts` 按逻辑 model 写死**单个** provider——无链、无降级，失败即失败；未注册的 model 直接 400（`model_not_found`），不设回落。
- rerank：`src/rerank/models.ts` 同 embeddings——按逻辑 model 写死单个 provider，无链、无降级；未注册的 model 直接 400（`model_not_found`）。
- email：`src/email/runner.ts` 的 `EMAIL_CHAIN` 固定 exmail → sendgrid。**单次尝试 + 安全降级**：每家恰好一次（`withRetry` 传 `maxAttempts:1`，仅取遥测接线），「确定没发出」的失败换下家；`DeliveryUncertainError`（投递状态未知：SMTP DATA 354 后超时/断连、SendGrid fetch 抛错）立即中止不降级，返回 502 `delivery_uncertain`——邮件不幂等，防重复发信，勿「统一」成 DEFAULT_RETRY。收件人解析与 to>cc>bcc 去重在 `src/email/address.ts`；from 内置于各 provider 文件；`smtp-client.ts` 是协议传输库（依赖注入 connect 便于 mock），不算供应商适配层。
- weather：`src/weather/runner.ts` 单 provider（open-meteo，**免 key**，勿加 ENV_KEY）。位置解析四选一：`latitude`/`longitude` 直传 > 地图分享链接（`src/weather/coords.ts` 解析百度 `@x,y,z`（BD-09MC）、百度 marker `?location=`（BD-09）、高德 marker `?position=`（GCJ-02），统一换算 WGS-84）> 地名 geocode（GeoNames，count=1，命中多个取第一个）> 调用方 IP 兜底（`request.cf` 城市级坐标）。地理编码与预报**两阶段各自独立** withRetry；地名查无结果 404 `location_not_found`（非上游失败，不重试不降级）；预报响应原样透传，入口层包 `{location, weather}` 信封。遥测 provider id：地理编码阶段 `open-meteo-geocode`、预报阶段 `open-meteo`。

### 错误与重试

- 单家：最多 3 次请求（重试 2 次），间隔 1s（`DEFAULT_RETRY`）；runner 层逐家串行，第一家成功即返回，全链失败 → 502 附各家 `ProviderError` 明细。
- chat 错误体为 OpenAI 风格 `{error:{message,type,code,provider_errors?}}`；read 为简化形 `{error:{message,provider_errors?}}`；embeddings/rerank 同 chat 的 OpenAI 风格（单家失败 502，code=`provider_failed`）；email 同 chat 的 OpenAI 风格（全链失败 502，code=`all_providers_failed`；投递状态未知 502，code=`delivery_uncertain`）；weather 同 chat 的 OpenAI 风格（上游失败 502，code=`provider_failed`；地名查不到 404，code=`location_not_found`；入参问题 400，code=`invalid_location`/`invalid_days`/`ambiguous_location`/`unparseable_map_link`/`location_required`）。勿混用。
- 请求体防御：入口解析后访问属性前先做 `?? {}` 守卫（合法 JSON `null` 体会解析成功）。

## 密钥与环境变量

- 本地：`.dev.vars`（已 gitignore，**严禁提交真实密钥**），模板见 `.dev.vars.example`。
- 生产：`wrangler secret put <KEY>`。**生产所有变量一律用 secret**（勿在 dashboard 配明文 var——git push 自动部署会清掉未声明的明文 var）。
- 网关调用 token：存 D1 `tokens` 表（SHA-256 哈希），经 `/admin` 后台管理（登录密钥 `ADMIN_TOKEN` secret）；禁用立即生效，无需重新部署。
- `ADMIN_TOKEN` 未配置时 `/admin/api/*` 返回 404（`/admin` 本身是不含数据的静态登录壳，照常返回），业务接口不受影响。
- 供应商 key 一律可选：缺 key 的供应商按 `NonRetryableError` 快速跳过换下家，不要改成启动时报错。

## 测试约定

- vitest，上游 fetch 全部 mock（`vi.stubGlobal`/`vi.mock`），**测试中不得出现真实网络调用**。
- 测试断言真实行为（请求 URL/header/body、状态码、响应体），不要只断言 mock 被调用。
- 新增供应商：覆盖缺 key、网络错、可重试/不可重试状态码、非 JSON、空内容、成功提取这几条路径。
- D1 相关测试用 `test/helpers.ts` 的 `makeFakeD1()`（可 stub rows/run meta/注入故障）与 `makeFakeCtx()`（收集 waitUntil promise），不依赖真实 D1。

## 新增一个 chat 供应商（checklist）

1. `src/chat/providers/` 新建文件，仿照 `openrouter.ts`（自包含：BASE_URL/UPSTREAM_MODEL/ENV_KEY/capabilities/chat）。
2. `src/chat/chains.ts` 相应链中按降级顺序插入（probe 依赖 chains 注册：`scripts/probe.ts` 从 CHAINS 按 id 解析供应商）。
3. `npm run probe -- <providerId>` 实测四项能力（systemPrompt/tools/jsonObject/jsonSchema），按输出建议校准 `capabilities`——**能力声明必须实测确认，不得凭文档或推断写入**。注意：探测单次上限 30s，慢模型（如默认开思考模式的 Qwen3）易超时得 inconclusive，须用 curl 放宽超时复测；json_schema 要用与提示词无关的严格 schema 做判别测试，确认是真执行而非被忽略。
4. `.dev.vars.example` 与生产 secret 补 key；`README.md` 配置表补一行。
5. 测试按上节约定补齐；`npm run typecheck && npm test` 全绿后提交。

## 已知边界（fix-later，勿在无关改动中顺手重构）

见 `docs/superpowers/reports/2026-08-14-providers-gateway-completion.md`：retry.ts 循环后死代码、供应商 `res.text()` 中断未按网络错归类、部分错误路径测试缺口、日志格式与规格的表述差异（行为一致）。改动涉及这些文件时保持现状语义，除非任务明确要求修复。
