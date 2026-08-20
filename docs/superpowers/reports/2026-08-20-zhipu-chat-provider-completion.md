# zhipu chat 供应商上线记录（2026-08-20）

## probe 实测结论（Task 3）

四项能力经 `npm run probe -- zhipu`（真实上游请求）+ curl 判别/复测实测验证。最终 capabilities：

```typescript
capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: false },
```

### probe 原始输出（逐字）

探测窗口恰逢 glm-4.7-flash 模型级限流（HTTP 429 code 1305），四项全部 inconclusive（非 rejected，不能据此判 false）：

```
探测 provider "zhipu"，将发起 4 次真实上游请求...

systemPrompt  [inconclusive] upstream 429: {"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}
tools         [inconclusive] upstream 429: {"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}
jsonObject    [inconclusive] upstream 429: {"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}
jsonSchema    [inconclusive] upstream 429: {"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}

建议配置（src/chat/providers/ 中该 provider 的 capabilities）：
  capabilities: { systemPrompt: false, tools: false, jsonObject: false, jsonSchema: false }

注意：存在 inconclusive 项（网络错误/5xx/超时或密钥未配置），相关结论建议人工复核。
```

probe 单次直连无重试（单次上限 30s），瞬时限流即 inconclusive——这正是 curl 复测的用途；下述各项均以 curl 判定为准。

### jsonSchema 判别测试（必跑项）

提示词与 schema 无关（提示词只让模型自我介绍，schema 却强制 `fruit` 只允许 `"banana"`）——只有真执行 schema 约束才可能输出 banana：

- 请求：`response_format: {"type":"json_schema","json_schema":{"name":"fruit_reply","strict":true,"schema":{...fruit enum ["banana"]、note、required、additionalProperties:false}}}`
- 第 1 次：HTTP 429 code 1305（限流，间隔 15s 重试）。
- 第 2 次：**HTTP 200，time 41.06s**。
- 响应关键内容：`choices[0].message.content` = `"I am an AI language model trained to understand and generate text to assist with a wide variety of tasks."` —— 自由文本自我介绍，非 JSON、无 `"fruit":"banana"`。
- **判定：请求被接受（200 非 400）但 schema 被忽略 → jsonSchema=false。**
- 佐证：该次 `prompt_tokens` 仅 13，reasoning_content 是普通自我介绍思考过程——上游对 `json_schema` 未注入任何约束提示词；对比 json_object 复测（见下）上游确实注入了 JSON 模式提示词（prompt_tokens 69）。即上游是"静默丢弃 json_schema 参数"，而非执行失败。

### 复测 curl（四项均 inconclusive，逐项复测）

**systemPrompt → true**（判定：200 且 content 近似只含 `pong`）：

- 请求：system 消息 `"You are a test bot. Reply only with the single word pong."` + user `"ping"`。
- 结果：HTTP 200，time 44.01s，`content` = `"pong"`（严格遵循 system 指令）。
- **判定：system 消息真实生效 → true。**

**tools → true**（判定：200 即 accepted；返回 tool_calls 则行为亦验证）：

- 首次尝试误发了非简报原文的 body（多加了消息，作废不采信；其响应亦为 429）。随后按简报原文 body 复测：第 1–3 次（间隔 15s/15s，及 jsonObject 复测后间隔 30s）均为 HTTP 429 code 1305（模型级限流持续）；第 4 次（间隔 60s）为本地 DNS 解析失败（curl exit 6，非上游数据点）；第 5 次（间隔 20s）：**HTTP 200，time 37.96s**，`finish_reason` = `"tool_calls"`，且实际返回 `tool_calls: [{function: {arguments: "{\"city\":\"Paris\"}", name: "get_weather"}, ...}]`。
- **判定：请求被接受且工具调用行为真实发生（参数正确）→ true。** 另注意该次 `prompt_tokens` = 166（对比无 tools 调用的 13–21），上游疑似注入了工具协议 system 提示词。

**jsonObject → true**（判定：200 且 content 为合法 JSON）：

- 第 1 次：120s 超时（HTTP 000，0 字节——限流排队表现）；第 2 次（15s 后）：HTTP 429 code 1305。
- 第 3 次（15s 后）：**HTTP 200，time 48.91s**，`content` = `"{\"ok\":true}"` —— 合法 JSON。
- **判定：json_object 模式真实生效 → true。**
- 佐证：reasoning_content 中出现上游注入的 JSON 模式指令（"You should always follow instructions and output a valid JSON object"、fallback `{"answer": "$your_answer"}`、markdown 代码块收尾要求），`prompt_tokens` = 69——上游对 json_object 有服务端提示词注入强制，与 json_schema 的静默忽略形成对照。

**jsonSchema → false**：只认判别测试结论（见上节），probe 的 inconclusive 不影响。

### 耗时与 reasoning_content 观察（默认思考行为）

- **glm-4.7-flash 默认开启思考模式**：每次响应均含 `reasoning_content`，且占比高——判别测试 478 completion tokens 中 455 为 reasoning（95%）；systemPrompt 复测 75/72；tools 复测 97/74；jsonObject 复测 314/303。网关设计为响应原样透传，`reasoning_content` 字段会原样到达客户端（零注入是定案，不改设计；客户端如需剔除须自行处理）。
- **单次调用普遍 38–49s**（思考模式开销），超过 probe 的 30s 上限与网关 `UPSTREAM_TIMEOUT_MS`=30s。意味着经网关调用 zhipu 时单次尝试超时概率不低（超时属 RetryableError，供应商内部还有 2 次重试 + 链上 agnes/gptsapi 降级兜底，但整体延迟会偏高）。运维观察项：若 glm-4.7-flash 持续慢，可考虑上游侧关思考参数——当前零注入设计下网关不会代为注入。
- **模型级限流（429 code 1305）当天反复出现**，突发性强、间隔 15–30s 重试可穿透。对网关而言 429 属可重试错误（classifyHttpStatus），行为正确。

### 校准落地

- `src/chat/providers/zhipu.ts`：capabilities 终值如上，占位注释替换为实测验证注释（含各项依据与 jsonSchema 降级说明）。
- `test/chat/providers.test.ts`：成功路径断言按「jsonSchema=false 且 jsonObject=true」分支调整——`sent.response_format` 断言从原样保留 json_schema 改为降级后的 `{"type":"json_object"}`。
- 验证：`npm run typecheck` 干净；`npx vitest run test/chat/providers.test.ts test/chat/chains.test.ts` 28/28；全量 `npm test` 18 文件 198/198 全绿。

## 交付物

分支 `zhipu-chat-provider`（基于 master @ `1527f0f`），共 5 个提交：

- `c4425f6` test: sync siliconflow assertion and README model name with c344005（Task 1 基线修复）
  - `test/chat/providers.test.ts`、`README.md`：siliconflow 断言与配置表中的 chat 上游模型名同步为 `Qwen/Qwen3.5-4B`（对齐 c344005 的 provider 实际值）
- `5e8302c` feat: add zhipu chat provider with glm-4.7-flash chain（Task 2，TDD：先测试 RED 再实现 GREEN）
  - `src/chat/providers/zhipu.ts`（新供应商，自包含：BASE_URL `https://open.bigmodel.cn/api/paas/v4`、UPSTREAM_MODEL `glm-4.7-flash`、ENV_KEY `ZHIPU_API_KEY`）
  - `src/env.ts`（`Env` 增加 `ZHIPU_API_KEY?: string`）
  - `src/chat/chains.ts`（新逻辑链 `"glm-4.7-flash": [zhipu, agnes, gptsapi]`——zhipu 首位，降级顺序 agnes → gptsapi）
  - `test/chat/providers.test.ts`（+6：缺 key、网络错、429 可重试、400 不可重试、非 JSON、成功提取）、`test/chat/chains.test.ts`（+1 链映射断言）
- `feaded3` feat: calibrate zhipu capabilities from live probe（Task 3）
  - `src/chat/providers/zhipu.ts`（capabilities 实测终值 + 逐项验证注释）、`test/chat/providers.test.ts`（成功路径断言改为 json_object 降级）、本报告初稿（probe 实测结论全节）
- `f8b545c` docs: correct tools retest attempt log in zhipu probe report（Task 3 纠错：复测尝试记录表述修正）
- 本提交 docs: add zhipu config docs, fix provider checklist order, complete report（Task 4）
  - `.dev.vars.example`（chat 段补 `ZHIPU_API_KEY=`）、`README.md`（配置表补 zhipu 行）、`AGENTS.md`（新增 chat 供应商 checklist 步骤 2/3 对调：chains 注册先于 probe，因 `scripts/probe.ts` 从 CHAINS 按 id 解析供应商，原顺序不可执行）、本报告补全

## 验收结果

- `npm run typecheck`：干净（`tsc --noEmit` 无输出，exit 0）。
- `npm test`：**18 文件 198/198 全绿**（191 基线 + zhipu 供应商 6 + 链 1），无失败、无跳过。
- 测试中上游 fetch 全部 mock，无真实网络调用；分支仅在本地，未 push。

## 遗留与后续

1. **生产部署**（用户执行，本分支未 push）：`wrangler secret put ZHIPU_API_KEY` 后 git push 自动部署，线上用 `?provider=zhipu` 做隔离验证。
2. **README 配置表缺 `AGNES_API_KEY` 行**（既有遗漏，早于本分支，本任务未修）。
3. **`chains.ts` 逻辑 model 键名 `"Qwen/Qwen3-8B"` 与上游实际模型 `Qwen/Qwen3.5-4B` 键名不一致**（c344005 现状，spec 范围外，保持不动）。
4. **运维观察项**：glm-4.7-flash 默认思考模式单次实测 38–49s，超网关 `UPSTREAM_TIMEOUT_MS`=30s——默认请求单次尝试大概率超时（超时属 RetryableError，供应商内部重试耗尽后降级到链上下家 agnes，整体延迟偏高）；调用方显式传 `thinking: {"type":"disabled"}` 可透传生效（`sanitizeRequest` 仅裁剪 tools/response_format/system，零注入设计，网关不代为注入）；`reasoning_content` 约占响应体积 95%，生产 token 用量与响应体积需关注。
