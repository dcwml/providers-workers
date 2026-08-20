# Jina embeddings provider 设计（jina / jina-embeddings-v5-omni-small）

- 日期：2026-08-20
- 状态：已批准（用户确认三决策点：复用 JINA_API_KEY / task·normalized 白名单透传 / 多模态 input 类型加宽；九节设计呈报无异议）
- 范围：embeddings 模块新增供应商；含 c344005 红基线顺手修复；不含生产部署（secret 更新与 git push 另行安排）

## 1. 背景与目标

providers 网关（Cloudflare Workers，OpenAI 兼容）embeddings 模块新增第二家供应商 Jina（`https://api.jina.ai/v1/embeddings`），上游模型 `jina-embeddings-v5-omni-small`（多模态，默认 1024 维）。注册为新逻辑 model，单 provider、无链、无降级——embeddings 模块既有架构不变；现有 `BAAI/bge-m3` → siliconflow 完全不动。

## 2. 实测结论（设计依据，2026-08-20 真实调用验证）

- 本机直连 `api.jina.ai` 被 DNS 污染，实测走 `127.0.0.1:7890` 代理；生产 Workers 出网不受影响
- 不带 `task` 可正常调用（200，走 Jina 默认行为）；`task: "retrieval.query"` + `normalized: true` 亦正常
- 多模态对象输入 `[{text}, {image: <base64>}]` 返回对应数量 1024 维向量；usage 区分 `prompt_tokens` / `image_tokens`
- 响应标准 OpenAI 风格（`data[].embedding` + `model` + `usage`），现有提取逻辑直接适用
- 用户提供的 key 与 `.dev.vars` 现有 `JINA_API_KEY`（read 链在用）不是同一把；定案为新 key 覆盖、read + embeddings 共用
- 实施时补测：`dimensions` / `encoding_format` 在 jina 的实际行为，结论写入 API 文档（不测不写）

## 3. 设计决策

| 决策点 | 结论 |
|---|---|
| 命名 | providerId=`jina`（与 read 链的 jina 同 id、不同命名空间，互不影响）；逻辑 model 沿用上游名 `jina-embeddings-v5-omni-small`（bge-m3 先例） |
| key | 复用 `JINA_API_KEY`（read + embeddings 共用）；`.dev.vars` 更新为新 key，生产 `wrangler secret put JINA_API_KEY`（新值） |
| 白名单 | `input` / `encoding_format` / `dimensions` / `user` + `task` + `normalized`（后两项为 jina 专属扩展，透传；siliconflow 白名单不变）；task/normalized 经索引签名读取，不加进共享 `EmbeddingsRequest` 显式字段（保持该类型 OpenAI 语义） |
| 多模态 | `types.ts` 的 input 加宽为 `string \| Array<string \| { text?: string; image?: string }>`；入口运行时校验无需改动（input 仅查非空 string/array，消费点已全仓核对） |
| task 默认值 | 不注入——不传走 Jina 默认行为（实测可用）；注入会覆盖调用方意图、引入隐式行为 |

## 4. 组件设计

### 4.1 新增 `src/embeddings/providers/jina.ts`

逐行仿 `src/embeddings/providers/siliconflow.ts`（自包含、不抽公共适配器——项目明确架构选择）：

- `BASE_URL = "https://api.jina.ai/v1"`
- `UPSTREAM_MODEL = "jina-embeddings-v5-omni-small"`
- `ENV_KEY = "JINA_API_KEY"`
- `embed()` 流程：缺 key → `NonRetryableError`（消息保持 `${ENV_KEY} is not configured` 格式）；body 构造 `{ model: UPSTREAM_MODEL（改写）, input }` + `encoding_format` / `dimensions` / `user` / `task` / `normalized` 按存在与否透传，其余字段丢弃 → fetch（Bearer 头，signal 透传）→ 非 2xx 走 `classifyHttpStatus` → 非 JSON 走 `RetryableError`（消息前缀 `jina embeddings:`）→ `data` 空数组或响应非对象 → `NonRetryableError` → JSON 原样返回

### 4.2 `src/embeddings/models.ts`

`MODELS` 增一行 `"jina-embeddings-v5-omni-small": jina`。jina 随之进入 ALL_PROVIDERS / `EMBEDDINGS_PROVIDER_IDS`（顺序 `["siliconflow", "jina"]`），`?provider=jina` 隔离调试参数经既有 `getEmbeddingsProviderById` 自动可用，无需其它改动。

### 4.3 `src/embeddings/types.ts`

input 类型加宽为 `string | Array<string | { text?: string; image?: string }>`（多模态对象项）。已核对全仓消费点：`index.ts` 运行时校验（不假设元素类型）与 `siliconflow.ts`（原样透传 body.input），类型加宽零破坏。

## 5. 错误处理

统一口径（与 embeddings 现有逐条一致）：缺 API key → `NonRetryableError`；fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`（5xx/429 可重试，其它 4xx 不可重试）；响应非 JSON → `RetryableError`；`data` 空数组或非对象 → `NonRetryableError`。单 provider 失败 502 `provider_failed` + provider_errors 为 runner 既有行为，无需改动。

## 6. 实施顺序

embeddings 无 probe 步骤（probe 为 chat 专用；能力结论已由第 2 节实测取得）：

1. 写 `src/embeddings/providers/jina.ts`
2. `src/embeddings/models.ts` 注册
3. `src/embeddings/types.ts` input 加宽
4. `test/embeddings/providers.test.ts` 追加 jina describe（9 条）+ `test/embeddings/runner.test.ts` 两处列表断言同步 + 新增映射断言
5. 基线顺手修（c344005 遗留，用户已批准）：`test/chat/providers.test.ts` 第 111 行断言 `Qwen/Qwen3-8B` → `Qwen/Qwen3.5-4B`；`README.md` 配置表 siliconflow 行模型名同步
6. 文档更新（详见第 8 节）；`.dev.vars` 由 Agent 写入新 key（gitignored，不进版本库）
7. `npm run typecheck && npm test` 全绿
8. 实施时走本机代理补测 `dimensions` / `encoding_format` 行为，结论写入 API 文档注意事项

## 7. 测试计划

`test/embeddings/providers.test.ts` 追加 `describe("jina embeddings")`，对齐 siliconflow 模式 + jina 特有断言：

1. 成功路径：请求到达 `https://api.jina.ai/v1/embeddings`；sent body 断言 `model` 改写为 `jina-embeddings-v5-omni-small`、`task` / `normalized` / `encoding_format` / `dimensions` / `user` 透传、bogus 字段被裁剪；多模态对象 input（`[{text}, {image}]`）原样透传；`authorization: Bearer <key>` 正确；响应原样透传
2. 可选字段缺省：sent = `{ model, input }`
3. 缺 key → `NonRetryableError`
4. 429 → `RetryableError`
5. 400 → `NonRetryableError`
6. 网络错 → `RetryableError`
7. 非 JSON 响应 → `RetryableError`
8. 空 `data` 数组 → `NonRetryableError`
9. 非对象 JSON 响应 → `NonRetryableError`

`test/embeddings/runner.test.ts`：

- `EMBEDDING_MODEL_IDS` 断言同步为 `["BAAI/bge-m3", "jina-embeddings-v5-omni-small"]`
- `EMBEDDINGS_PROVIDER_IDS` 断言同步为 `["siliconflow", "jina"]`
- 新增 1 条：`getEmbeddingsProviderByModel("jina-embeddings-v5-omni-small")?.id === "jina"`

测试基线：当前 191 个测试含 1 个已知失败（c344005 遗留，chat/providers.test.ts 第 111 行）；断言修复后 191 全绿；新增 jina 10 条后共 201（以实际为准）。

## 8. 文档改动

- `README.md` 三处：端点表 `/v1/embeddings` 行加 jina model；配置表 `JINA_API_KEY` 行改为「read 供应商 + embeddings 供应商 jina（上游模型 jina-embeddings-v5-omni-small）共用」；配置表 siliconflow 行模型名顺手修为 `Qwen/Qwen3.5-4B`
- `docs/API-embeddings.md`：请求格式表（`input` 补对象形式与多模态说明、jina 专属 `task` / `normalized` 字段说明）；白名单裁剪说明（jina 额外透传两字段）；model 映射表加行；错误码表 `valid models` 示例同步；`?provider=` 合法取值加 `jina`；调用示例（`task` 与多模态各补一例）；生产现状小节更新
- `.dev.vars.example`：`JINA_API_KEY` 行注释更新为 read + embeddings 供应商 jina 共用（保留原位置，加注说明）

## 9. 验收标准

- `npm run typecheck && npm test` 全绿（共 201 个测试，以实际为准）
- `README` / `.dev.vars.example` / `docs/API-embeddings.md` 与实现一致
- `dimensions` / `encoding_format` 实测结论已写入 API 文档（或明确记录上游不支持）

## 10. 范围外（记录不实施）

- 生产部署：`wrangler secret put JINA_API_KEY`（新值）+ git push 自动部署 + 线上验证（model 名或 `?provider=jina`），用户执行，验收后另行安排
- 本 key 已出现在聊天记录，如介意可在部署验证后于 Jina 后台轮换（更新 `.dev.vars` 与 secret 即可，代码不动）
- zhipu chat provider 任务（独立排队；其「顺手修基线」步骤因本任务先行变 no-op）
- siliconflow embeddings 白名单行为（保持不动）
- README 配置表缺 agnes 行（既有遗漏，与本任务无关）
- chains.ts 逻辑 model 键名 `"Qwen/Qwen3-8B"` 与其上游 `Qwen/Qwen3.5-4B` 名称不一致（c344005 现状，保持不动）
