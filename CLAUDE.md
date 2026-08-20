# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Cloudflare Workers 上的多供应商聚合网关：OpenAI 兼容 chat 接口（仅非流式）+ 页面读取接口，内置重试与供应商自动降级。无框架、无 lint， TypeScript + wrangler + vitest。

## 常用命令

```bash
npm run dev          # wrangler dev 本地启动（密钥放 .dev.vars）
npm test             # vitest 全量单测（上游全部 mock）
npm run typecheck    # tsc --noEmit
npx vitest run test/chat/runner.test.ts   # 运行单个测试文件
npm run probe -- openrouter   # 实测某 chat provider 的四项能力（发真实请求）
npx tsx scripts/serve.ts      # 备用本地服务（D1 改造后鉴权路径不可用，本地联调优先 npm run dev）
npm run deploy       # wrangler deploy（发布前建议先 wrangler deploy --dry-run）
```

## 部署

提交到 git 并推送到远端后会自动部署到生产（Workers CI），无需手动 `npm run deploy`。

## 架构

请求流：`src/index.ts` 路由（业务端点 + `/admin` 管理后台）→ auth 校验（`src/auth.ts`，Bearer token 的 SHA-256 查 D1 `tokens` 表，库 `providers_db`）→ runner。每次调用与每次上游尝试经 `src/telemetry.ts`（RequestRecorder，waitUntil 异步）落 D1 监控，查询集见 `docs/monitoring-sql.md`。

两条对称的执行管线，模式相同（runner 按链顺序遍历供应商，每家用 `withRetry` 包裹，失败换下一家，全链失败返回 502 附各家错误明细）：

- **chat**：`src/chat/runner.ts` 按逻辑 model 从 `src/chat/chains.ts` 的 `CHAINS` 取供应商链 → provider 发请求。响应原样透传。
- **read**：`src/read/runner.ts`，链写死 jina → tavily → firecrawl，返回页面 Markdown。

关键机制：

- **重试分类**（`src/errors.ts` + `src/retry.ts`）：只有 `RetryableError` 会被重试（默认 3 次尝试、间隔 1s，`src/config.ts`）；429/5xx/网络错/超时可重试，其它 4xx 抛 `NonRetryableError` 立即降级到下一家。每次上游调用经 `AbortSignal.timeout(30s)` 超时。
- **capabilities 裁剪**（`src/chat/sanitize.ts`）：每个 chat provider 声明 `capabilities`（systemPrompt/tools/jsonObject/jsonSchema），`sanitizeRequest` 据此裁剪请求——不支持 system 时把 system 消息合并进首条 user 消息，不支持 json_schema 时降级为 json_object 或删除。provider 内先 sanitize 再改写 `body.model` 为上游真实 model 名。
- provider 文件（`src/chat/providers/`、`src/read/providers/`）自带 `BASE_URL`/`UPSTREAM_MODEL`/`ENV_KEY` 常量，从 `env[ENV_KEY]` 读密钥。

## 新增 chat 供应商

1. `src/chat/providers/` 新建文件仿照 `openrouter.ts`；
2. 在 `src/chat/chains.ts` 的 `CHAINS` 中为相应逻辑 model 插入（顺序即降级顺序）；
3. `src/env.ts`、`.dev.vars.example` 补上对应 key（生产用 `wrangler secret put`）；
4. 运行 `npm run probe -- <providerId>`（逻辑：`src/chat/probe.ts`，临时把 capabilities 置全 true 绕过 sanitize，对上游发 4 个最小请求），按输出的建议配置改准 `capabilities`。

## 测试约定

vitest 测试位于 `test/`（目录结构镜像 src），所有上游 fetch 均 mock，不发真实请求。runner 测试可通过 `retryOverrides` 参数缩短重试等待。
