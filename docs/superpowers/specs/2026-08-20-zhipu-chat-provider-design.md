# 智谱 chat provider 设计（zhipu / glm-4.7-flash）

- 日期：2026-08-20
- 状态：已批准（用户确认三决策点：新逻辑 model 自成链 / thinking 零注入纯透传 / zhipu + ZHIPU_API_KEY；基线红测试本任务顺手修复）
- 范围：chat 模块新增供应商；不含生产部署（secret 配置与 git push 另行安排）

## 1. 背景与目标

providers 网关（Cloudflare Workers，OpenAI 兼容）新增第 6 家 chat 供应商智谱 BigModel（open.bigmodel.cn），上游模型 `glm-4.7-flash`。注册为新逻辑 model `glm-4.7-flash` 自成链，调用方显式指定 model 才路由到智谱；现有三条链（agnes-2.0-flash / Qwen/Qwen3-8B / gpt-5.4-nano）与未注册回落 agnes 均不变。

## 2. 设计决策

| 决策点 | 结论 |
|---|---|
| 命名 | providerId=`zhipu`，ENV_KEY=`ZHIPU_API_KEY` |
| 链 | `"glm-4.7-flash": [zhipu, agnes, gptsapi]`（新逻辑 model，自成链） |
| thinking / 默认参数 | 零注入纯透传：不注入 thinking / max_tokens / temperature 等任何默认值；调用方显式传 `thinking` 等非标准字段时原样透传生效（sanitize 不删未知字段），不传则跟随智谱默认行为 |
| capabilities | 必须 `npm run probe -- zhipu` 实测四项后写入，不得凭文档或推断写入 |
| 响应 | 原样透传（含 `reasoning_content` 等智谱特有字段，不改上游 JSON 任何字段） |

## 3. 组件设计

### 3.1 新增 `src/chat/providers/zhipu.ts`

逐行仿 `src/chat/providers/siliconflow.ts`（当前最完整模板），自包含、不抽公共适配器（项目明确架构选择）：

- `BASE_URL = "https://open.bigmodel.cn/api/paas/v4"`
- `UPSTREAM_MODEL = "glm-4.7-flash"`
- `ENV_KEY = "ZHIPU_API_KEY"`
- `capabilities`：初始占位全 true，probe 实测后校准（probeProvider 会临时覆盖为全 true 再恢复，占位值不影响探测结果）
- `chat()` 流程：缺 key → `NonRetryableError`；`sanitizeRequest` 按 capabilities 裁剪 → `body.model` 改写为 UPSTREAM_MODEL → fetch（Bearer 头，signal 透传）→ 非 2xx 走 `classifyHttpStatus` → 非 JSON 走 `RetryableError`（消息前缀 `zhipu:`）→ JSON 原样返回

### 3.2 `src/chat/chains.ts`

CHAINS 增加一行 `"glm-4.7-flash": [zhipu, agnes, gptsapi]`；FALLBACK_CHAIN 与其余三链不动。zhipu 随之进入 ALL_PROVIDERS / CHAT_PROVIDER_IDS，`?provider=zhipu` 隔离测试自动可用，无需其它改动。

### 3.3 配置与文档

- `.dev.vars.example` chat 段补 `ZHIPU_API_KEY=`
- `README.md` 配置表补一行：`| ZHIPU_API_KEY | chat 供应商 zhipu（上游模型 glm-4.7-flash）|`
- 顺手修复（用户提交 c344005 的遗漏，基线恢复绿）：
  - `test/chat/providers.test.ts` siliconflow 断言 `Qwen/Qwen3-8B` → `Qwen/Qwen3.5-4B`
  - `README.md` 配置表 siliconflow 行模型名同步为 `Qwen/Qwen3.5-4B`

## 4. 错误处理

统一口径：缺 API key → `NonRetryableError`；fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`（5xx/429 可重试，其它 4xx 不可重试但仍换下家）；响应非 JSON → `RetryableError`。全链失败 502 附 provider_errors 为 runner 既有行为，无需改动。

## 5. 实施顺序（关键约束）

`scripts/probe.ts` 的 `findProvider()` 从 CHAINS 按 id 解析供应商——**provider 必须先进 chains 才能被 probe 找到**。顺序：

1. 写 `src/chat/providers/zhipu.ts`（capabilities 占位全 true）
2. `src/chat/chains.ts` 插入新链
3. `npm run probe -- zhipu`（前置：`.dev.vars` 填入 ZHIPU_API_KEY——当前该文件尚无此键，实施时提醒用户填入）
4. 按 probe 输出校准 capabilities；单次探测上限 30s，GLM-4.7-Flash 若超时得 inconclusive，用 curl 放宽超时复测；json_schema 项用与提示词无关的严格 schema 判别测试，确认真执行而非被忽略
5. `.dev.vars.example` / `README.md` 更新（含顺手修复）
6. `test/chat/providers.test.ts` 追加 zhipu 测试
7. `npm run typecheck && npm test` 全绿

## 6. 测试计划

`test/chat/providers.test.ts` 追加 `describe("zhipu")`，对齐 siliconflow / gptsapi 的 6 条模式：

1. 成功路径：请求到达 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，model 改写为 `glm-4.7-flash`，`response_format`（json_schema）按最终 capabilities 原样保留，`authorization: Bearer <key>` 正确，响应原样透传
2. 缺 key → `NonRetryableError`
3. 429 → `RetryableError`
4. 400 → `NonRetryableError`
5. 网络错 → `RetryableError`
6. 非 JSON 响应 → `RetryableError`

若 probe 校准后某能力为 false（如 systemPrompt 不支持），测试 1 断言相应调整（json_schema 降级 / system 并入首条 user）。

## 7. 验收标准

- `npm run typecheck && npm test` 全绿（当前基线 191 个测试，含 1 个已知失败；修复后 191 全绿，zhipu 完成后 192）
- probe 四项能力实测结论（含 curl 复测结果、默认思考行为观察）记录在完成报告
- README / .dev.vars.example 与实际配置一致

## 8. 范围外（记录不实施）

- 生产部署：`wrangler secret put ZHIPU_API_KEY` + git push 自动部署，验收后另行安排
- README 配置表缺 agnes 行（既有遗漏，与本任务无关）
- chains.ts 逻辑 model 键名 `"Qwen/Qwen3-8B"` 与其上游 `Qwen/Qwen3.5-4B` 名称不一致（c344005 现状，保持不动）
