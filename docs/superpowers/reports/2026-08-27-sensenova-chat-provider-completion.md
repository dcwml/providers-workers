# Sensenova chat provider 完成报告

- 日期：2026-08-27
- 分支：`sensenova-chat-provider`（基于 master @ `8c4b5c9`）
- Spec：`docs/superpowers/specs/2026-08-27-sensenova-chat-provider-design.md`
- 计划：`docs/superpowers/plans/2026-08-27-sensenova-chat-provider.md`

## 变更摘要

新增第 7 家 chat 供应商商汤 SenseNova（`token.sensenova.cn`），上游模型 `sensenova-6.8-flash-lite`，注册为新逻辑 model 自成链 `[sensenova, agnes, gptsapi]`。现有四链与 FALLBACK_CHAIN 不变；`?provider=sensenova` 隔离测试随 ALL_PROVIDERS 自动可用。

- `src/chat/providers/sensenova.ts`（新供应商，自包含：BASE_URL `https://token.sensenova.cn/v1`、UPSTREAM_MODEL `sensenova-6.8-flash-lite`、ENV_KEY `SENSENOVA_API_KEY`）
- `src/env.ts`（`Env` 增加 `SENSENOVA_API_KEY?: string`）
- `src/chat/chains.ts`（import + 新链 `"sensenova-6.8-flash-lite": [sensenova, agnes, gptsapi]`）
- `test/chat/providers.test.ts`（+6：成功路径含 json_object 降级断言、缺 key、429、400、网络错、非 JSON）、`test/chat/chains.test.ts`（+1 链映射断言）

## probe 实测结论（capabilities 终值）

`npm run probe -- sensenova` 逐字输出（2026-08-27）：

```
systemPrompt  [supported]
tools         [supported]   模型返回了 tool_calls
jsonObject    [inconclusive] network error: The operation was aborted due to timeout
jsonSchema    [rejected]     upstream 400: {"error":{"message":"guided_grammar '{...}' has compile_grammar_error: No module named 'xgrammar'","type":"invalid_request_error","code":"400"}}
```

### json_schema 判别测试（fruit=banana 严格 schema，与提示词无关）

```
HTTP 400 time 0.495s
guided_grammar compile_grammar_error: No module named 'xgrammar'
```

与 probe 的 400 同因——商汤后端把 `response_format.json_schema` 转成 vLLM guided_grammar，但 xgrammar 模块缺失，参数形状整体不被支持（非"被静默忽略"）。**jsonSchema=false 双重确认**，sanitize 自动降级 json_object。

### jsonObject 复测（inconclusive 项，curl -m 120）

```
HTTP 200 time 22.71s
content: "\n\n{\"ok\": true}"（前导空白后为合法 JSON）
```

**jsonObject=true**。probe 首测 30s 超时系模型默认开思考模式耗时所致，非能力缺失。

### 终值

```typescript
capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: false },
```

## 运维观察

1. **默认开思考模式**：响应 `choices[0].message.reasoning` 字段（注意：商汤字段名是 `reasoning`，非智谱的 `reasoning_content`），思考内容占响应体积大头（jsonObject 复测 completion_tokens=332，其中答案本体仅 ~10 token）。原样透传，网关不改。
2. **延迟**：单次请求实测 22.7s（开思考），接近网关 `UPSTREAM_TIMEOUT_MS`=30s 上限——默认请求单次尝试有超时风险（超时属 RetryableError，耗尽后降级 agnes，整体延迟偏高）。json_schema 判别请求 0.5s 快速失败（400 不经模型）。
3. **响应结构**：顶层含 `request_id`；`usage.completion_tokens_details.reasoning_tokens=0`（与 reasoning 字段实际有内容不符，上游统计口径问题，仅记录）。

## 提交列表

master（spec/plan）：

- `8788fe7` docs: add sensenova chat provider design spec
- `8c4b5c9` docs: add sensenova chat provider implementation plan

分支 `sensenova-chat-provider`（基于 master @ `8c4b5c9`）：

- `4291688` feat: add sensenova chat provider with sensenova-6.8-flash-lite chain（Task 1，TDD：先测试 RED 再实现 GREEN）
- `4744b71` feat: calibrate sensenova capabilities from live probe（Task 2：capabilities 实测终值 + 逐项验证注释 + 成功路径断言改为 json_object 降级 + 本报告初稿）
- 本提交 docs: add sensenova config docs and completion report（Task 3：`.dev.vars.example` 补 `SENSENOVA_API_KEY=`、`README.md` 配置表补行、本报告补全）

## 验收结果

- `npm run typecheck`：干净（`tsc --noEmit` 无输出，exit 0）。
- `npm test`：**22 文件 280/280 全绿**（273 基线 + sensenova 供应商 6 + 链 1），无失败、无跳过。
- 测试中上游 fetch 全部 mock，无真实网络调用；probe/curl 实测仅在 Task 2 按计划进行。已于 2026-08-27 push（136f23b..7233b81）并自动部署（见「生产部署与线上验证」）。

## 生产部署与线上验证（2026-08-27 已完成）

- 推送前 L3 深度安全审查：0 findings。
- `SENSENOVA_API_KEY` 生产 secret 已配置（用户操作，`wrangler secret list` 确认）；git push（136f23b..7233b81）自动部署成功，版本 90a87289 已 100% 接流。
- 线上实测：
  1. 无 token → 401 `unauthorized`（鉴权正常）
  2. 链路真发 `{"model":"sensenova-6.8-flash-lite",...}` → 200（总耗时 51.9s），`model` 透传 `sensenova-6.8-flash-lite`，`reasoning` 思考字段原样透传，content 为 `pong`
  3. `?provider=sensenova` 隔离路径 → 200（20.8s，单次成功）
- D1 `provider_attempts` 遥测核对（provider='sensenova' 共 3 行）：
  - 链路请求 c1aa1227：尝试1 超时（30000ms，`network error: The operation was aborted due to timeout`，result=retry）→ 尝试2 成功（20127ms，result=ok）——**超时重试机制生产实证**：模型默认思考模式单次 ~20s 贴近 30s 上限，首试超时属预期，重试后成功（30+1+20≈52s，与 curl 实测 51.9s 吻合）
  - 隔离请求 48c4e4e3：单次成功（19969ms，result=ok）

## 遗留与后续

1. 思考模式延迟问题：调用方可尝试显式传商汤支持的关闭思考参数（如有）——网关零注入设计，不代为注入；默认请求单次尝试有超时风险（生产已实证首试 30s 超时后重试成功的路径）。
2. 冒烟用网关 token 已出现在聊天记录，如介意可在 /admin 后台禁用或轮换。

## 后续变更：上游切 glm-5.2 + 链扩 5 家（2026-08-27，用户变更 + 同步验收 + 已上线）

用户调整（本地）：

- `src/chat/chains.ts`：五条链全部扩为 5 家（尾部追加 sensenova/zhipu 兑底）。
- `src/chat/providers/sensenova.ts`：UPSTREAM_MODEL 由 `sensenova-6.8-flash-lite` 改为商汤托管的 `glm-5.2`（Z.ai 系），逻辑链键名保留不变。

同步处理：

- **AGENTS.md 中用户误写的生产 token 明文行已删除**（git 跟踪文件，提交即泄露；.dev.vars 注释档已有同值，无损失）。
- capabilities 按 glm-5.2 重新实测校准：**四项全 true**——systemPrompt（curl 复测 200，content 仅 "pong"）、tools（probe supported，返回 tool_calls）、jsonObject（probe supported）、jsonSchema（fruit=banana 严格 schema 判别：思考过程未提 banana，content 输出符合 schema 的 `{"fruit":"banana",...}`，解码层真执行约束；与 flash-lite 的引擎 400 xgrammar 缺失不同，glm-5.2 引擎支持）。probe 首测遇 429（BurstRate + insufficient_quota），复测时避开分钟级配额窗口后全部通过。
- glm-5.2 行为观察：思考字段名 `reasoning_content`（非 flash-lite 的 `reasoning`），reasoning_tokens 统计正常，单次 1-11s（远快于 flash-lite 的 ~20s）；商汤工作区配额窗口紧（连续 2-3 请求即 429 insufficient_quota，分钟级恢复）。
- 测试同步：chains.test.ts 三条链断言 + sensenova 链断言改 5 家；providers.test.ts 成功路径断言 model→`glm-5.2`、response_format→json_schema 原样保留。`npm run typecheck && npm test` 22 文件 280/280 全绿。
- 文档同步：README 配置表、docs/API-chat.md（能力说明/链表/对照表/运维注意/生产现状）。
- 运维提醒：链扩 5 家后全链失败最坏耗时显著变长（每家最多 3 次×30s）；zhipu/sensenova 的 429 配额类错误在链尾兑底时成功率存疑。
- 生产验证（2026-08-27，提交 93712c7，部署版本 83f651b1）：链路调用 `sensenova-6.8-flash-lite` → 200（6.7s，单次成功），响应 `model` 透传 `glm-5.2`，`reasoning_content` 正常，D1 遥测单次落库（f90aa260，attempt 1，ok，4533ms）。推送前 L3 扫描因 Credits 耗尽未能执行（用户知情后选择跳过）。
