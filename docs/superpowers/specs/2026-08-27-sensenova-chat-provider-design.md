# 商汤 chat provider 设计（sensenova / sensenova-6.8-flash-lite）

- 日期：2026-08-27
- 状态：已批准（用户确认两决策点：新逻辑 model 自成链 sensenova → agnes → gptsapi / key 已在 .dev.vars）
- 范围：chat 模块新增供应商；不含生产部署（secret 配置与 git push 另行安排）

## 1. 背景与目标

providers 网关（Cloudflare Workers，OpenAI 兼容）新增第 7 家 chat 供应商商汤 SenseNova（token.sensenova.cn），上游模型 `sensenova-6.8-flash-lite`。注册为新逻辑 model `sensenova-6.8-flash-lite` 自成链，调用方显式指定 model 才路由到商汤；现有四条链（agnes-2.0-flash / Qwen/Qwen3-8B / gpt-5.4-nano / glm-4.7-flash）与未注册回落 agnes 均不变。

## 2. 设计决策

| 决策点 | 结论 |
|---|---|
| 命名 | providerId=`sensenova`，ENV_KEY=`SENSENOVA_API_KEY` |
| 链 | `"sensenova-6.8-flash-lite": [sensenova, agnes, gptsapi]`（新逻辑 model，自成链，降级顺序 agnes → gptsapi） |
| 默认参数 | 零注入纯透传：不注入 max_tokens / temperature 等任何默认值；调用方显式传的非标准字段原样透传（sanitize 不删未知字段），不传则跟随商汤默认行为 |
| capabilities | 必须 `npm run probe -- sensenova` 实测四项后写入，不得凭文档或推断写入 |
| 响应 | 原样透传（不改上游 JSON 任何字段，含商汤特有字段） |

## 3. 组件设计

### 3.1 新增 `src/chat/providers/sensenova.ts`

逐行仿 `src/chat/providers/zhipu.ts`（最近新增的同构模板），自包含、不抽公共适配器（项目明确架构选择）：

- `BASE_URL = "https://token.sensenova.cn/v1"`
- `UPSTREAM_MODEL = "sensenova-6.8-flash-lite"`
- `ENV_KEY = "SENSENOVA_API_KEY"`
- `capabilities`：初始占位全 true，probe 实测后校准（probeProvider 会临时覆盖为全 true 再恢复，占位值不影响探测结果）
- `chat()` 流程：缺 key → `NonRetryableError`（消息保持 `${ENV_KEY} is not configured` 格式——probe.ts 以 `is not configured$` 后缀识别环境问题，区别于能力被拒）；`sanitizeRequest` 按 capabilities 裁剪 → `body.model` 改写为 UPSTREAM_MODEL → fetch（Bearer 头，signal 透传）→ 非 2xx 走 `classifyHttpStatus` → 非 JSON 走 `RetryableError`（消息前缀 `sensenova:`）→ JSON 原样返回

### 3.2 `src/chat/chains.ts`

CHAINS 增加一行 `"sensenova-6.8-flash-lite": [sensenova, agnes, gptsapi]`；FALLBACK_CHAIN 与其余四链不动。sensenova 随之进入 ALL_PROVIDERS / CHAT_PROVIDER_IDS，`?provider=sensenova` 隔离测试自动可用，无需其它改动。

### 3.3 配置与文档

- `src/env.ts`：Env 接口补 `SENSENOVA_API_KEY?: string;`（对齐现有供应商显式声明惯例，`ZHIPU_API_KEY` 之后）
- `.dev.vars.example` chat 段补 `SENSENOVA_API_KEY=`（`.dev.vars` 用户已配好，实测确认键值非空）
- `README.md` 配置表补一行：`| SENSENOVA_API_KEY | chat 供应商 sensenova（上游模型 sensenova-6.8-flash-lite）|`

## 4. 错误处理

统一口径：缺 API key → `NonRetryableError`；fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`（5xx/429 可重试，其它 4xx 不可重试但仍换下家）；响应非 JSON → `RetryableError`。全链失败 502 附 provider_errors 为 runner 既有行为，无需改动。

## 5. 实施顺序（关键约束）

`scripts/probe.ts` 从 CHAINS 按 id 解析供应商——**provider 必须先进 chains 才能被 probe 找到**。顺序（TDD：Task 2 先写测试 RED 再实现 GREEN）：

1. 写 `src/chat/providers/sensenova.ts`（capabilities 占位全 true）+ env.ts 声明 + chains.ts 插入新链 + 测试
2. `npm run typecheck && npm test` 全绿
3. `npm run probe -- sensenova`（key 已在 .dev.vars，实测确认非空）
4. 按 probe 输出校准 capabilities；单次探测上限 30s，若超时得 inconclusive，用 curl 放宽超时复测；json_schema 项用与提示词无关的严格 schema 判别测试，确认真执行而非被忽略
5. 若校准后有能力变 false，回改测试成功路径断言（降级行为）
6. `.dev.vars.example` / `README.md` 更新
7. 完成报告记录 probe 实测结论

## 6. 测试计划

`test/chat/providers.test.ts` 追加 `describe("sensenova")`，对齐 zhipu 的 6 条模式：

1. 成功路径：请求到达 `https://token.sensenova.cn/v1/chat/completions`，model 改写为 `sensenova-6.8-flash-lite`，`response_format`（json_schema）按最终 capabilities 原样保留，`authorization: Bearer <key>` 正确，响应原样透传
2. 缺 key → `NonRetryableError`
3. 429 → `RetryableError`
4. 400 → `NonRetryableError`
5. 网络错 → `RetryableError`
6. 非 JSON 响应 → `RetryableError`

若 probe 校准后某能力为 false，测试 1 断言相应调整（json_schema 降级 json_object / system 并入首条 user）。

另在 `test/chat/chains.test.ts` 追加 1 条链顺序断言（对齐 glm-4.7-flash 既有先例）：`getChain("sensenova-6.8-flash-lite")` 的 provider id 依次为 `["sensenova", "agnes", "gptsapi"]`。

## 7. 验收标准

- `npm run typecheck && npm test` 全绿（当前基线 22 文件 273 测试；新增 sensenova 6 条 + chains 1 条后共 280）
- probe 四项能力实测结论（含 curl 复测结果）记录在完成报告
- README / .dev.vars.example 与实际配置一致

## 8. 范围外（记录不实施）

- 生产部署：`wrangler secret put SENSENOVA_API_KEY` + git push 自动部署，验收后另行安排
- chains.ts 逻辑 model 键名 `"Qwen/Qwen3-8B"` 与其上游 `Qwen/Qwen3.5-4B` 名称不一致（既有现状，保持不动）
