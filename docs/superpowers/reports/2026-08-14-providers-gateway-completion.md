# Providers 网关 — 实施完成报告

> 分支：`feat/providers-gateway`（基于 master @ `13604bb`），2026-08-14
> 规格：`docs/superpowers/specs/2026-08-14-providers-gateway-design.md`
> 计划：`docs/superpowers/plans/2026-08-14-providers-gateway.md`（11 任务，子代理逐任务执行 + 每任务独立评审）

## 交付内容

Cloudflare Workers 多供应商聚合网关，12 个提交（`13604bb..34c4564`），零运行时依赖，构建产物 15.18 KiB（gzip 3.82 KiB）。

- `POST /v1/chat/completions`：OpenAI 兼容（仅非流式）。按 `model` 查 `src/chat/chains.ts` 写死链；每家供应商独立文件（写死 base url + model，出请求时改写 model，响应原样透传）；能力裁剪（tools/response_format 删除或降级、system 并入首条 user）。示例链：`sample-chat` = openrouter → deepseek-official；`sample-reasoning` = deepseek-official → openrouter（占位，按需替换）。
- `POST /v1/read`：body `{"url"}`，返回 `text/markdown`。固定链 jina → tavily → firecrawl。
- 共享层：Bearer 鉴权（SHA-256+XOR 常量时间比较）、重试（每家 3 次、间隔 1s、仅 RetryableError 重试）、失败分类（网络错/超时/5xx/429 可重试；其它 4xx 不重试但换下家）、每尝试 30s 超时、结构化日志、全链失败 502 附各家错误明细。

## 验收状态

- `npm run typecheck` 干净；`npx vitest run` 77/77 通过（10 文件，上游全部 mock）；`npx wrangler deploy --dry-run` 构建成功。
- 每任务经独立评审（规格符合 + 代码质量），最终全分支评审结论「With fixes」→ 修复轮完成并复审通过（commit `34c4564`：null JSON body → 400、AUTH_TOKENS 未配置 → 401 的两处单行守卫）。

## 评审留档（parked / deferred，均来自计划原文逐字执行）

最终评审裁定：

1. `src/retry.ts` 循环后 `throw lastError` 不可达、`maxAttempts <= 0` 抛 undefined — **fix-later**（当前无调用方可达）。
2. `src/auth.ts` 命中首个 token 提前退出 — **accept**（无效 token 必遍历全部，无法利用）。
3. null JSON body → 500 — **已修**（`34c4564`）。
4. ReadOutcome 不带 title — **维持**（规格 read 响应即 Markdown 正文，title 仅在供应商层 ReadResult）。

延后的小项（均不阻塞合并，供后续按需处理）：各供应商部分错误路径测试缺口（chat 非 JSON→Retryable、tavily/firecrawl 缺 key 与网络错路径）、index 层测试缺口（messages 校验行、error.code/type 断言、read-502 的 provider_errors 断言）、tavily/firecrawl 上游返回 JSON `null` 时的分类、供应商 `res.text()` 中途中断归类为可重试、`retryOverrides` 展开顺序可能覆盖 onAttempt 日志、README 未提示 provider 方法依赖 `this` 不可解构。

另有两处计划与规格的表述差异（行为一致，仅记录）：能力键实现为驼峰 `jsonObject/jsonSchema`（规格写 `json_object/json_schema`）；日志格式 `attempt=1`（规格写 `attempt=1/3`）；`@cloudflare/workers-types` 因 wrangler peer 依赖由 ^4 升至 ^5.20260811.1（良性）。

## 用户待办

1. `cp .dev.vars.example .dev.vars` 填真实密钥（AUTH_TOKENS 必填，否则所有请求 401）。
2. `npm run dev` 后用 README 中的 curl 示例做真实上游冒烟（自动化范围外）。
3. `chains.ts` 供应商清单为示例占位，按真实供应商替换；正式部署执行 `npm run deploy`（生产 secret 用 `wrangler secret put`）。
