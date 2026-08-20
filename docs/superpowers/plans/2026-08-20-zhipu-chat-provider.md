# 智谱 chat provider（zhipu / glm-4.7-flash）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** providers 网关新增第 6 家 chat 供应商智谱 BigModel（上游模型 glm-4.7-flash），注册为新逻辑 model 自成链 `[zhipu, agnes, gptsapi]`，capabilities 经真实上游 probe 实测校准。

**Architecture:** 自包含 provider 文件（逐行仿 `siliconflow.ts`，不抽公共适配器）+ `chains.ts` 注册新链 + 零参数注入纯透传。**关键顺序约束：`scripts/probe.ts` 的 `findProvider()` 从 CHAINS 按 id 解析供应商，provider 必须先进 chains 才能被 probe**，故实施顺序为：代码与测试 → probe 实测 → 校准 capabilities → 配置文档。

**Tech Stack:** Cloudflare Workers（TypeScript strict）、vitest（全 mock 无真实网络）、tsx 脚本（probe 发真实上游请求）。

**Spec:** `docs/superpowers/specs/2026-08-20-zhipu-chat-provider-design.md`（已批准）

## Global Constraints

- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`；禁 `any`。
- `src/` 仅 Cloudflare Workers 运行时，无 Node API。
- 供应商自包含：**不抽公共适配器、不消除供应商间重复**（明确架构选择）。
- 响应一律原样透传（含 `reasoning_content` 等智谱特有字段）。
- 失败分类统一口径：缺 key → `NonRetryableError`；fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`；非 JSON → `RetryableError`。
- 缺 key 错误消息必须保持 `ZHIPU_API_KEY is not configured` 格式（`probe.ts` 以 `/is not configured$/` 正则区分环境问题与能力被拒，格式走样会导致 probe 误判为 rejected）。
- 零参数注入：不注入 thinking / max_tokens / temperature 等任何默认值；调用方显式传的非标准字段原样透传。
- capabilities 必须 probe 实测确认，不得凭文档或推断写入；inconclusive 项用 curl 放宽超时复测；json_schema 须严格 schema 判别测试确认真执行。
- 测试全 mock 无真实网络；断言真实行为（URL/header/body/状态码/响应体），不仅断言 mock 被调用。
- Bash 工具实际是 bash（非 cmd）。本任务**不 push、不 deploy**（生产走 git push 自动部署，`wrangler secret put ZHIPU_API_KEY` 验收后另行安排）；每任务一个本地 commit。
- 工作目录：`D:\Projects\study\providers`（bash 路径 `/d/projects/study/providers`）。

---

### Task 1: siliconflow 基线修复（测试断言 + README 模型名）

c344005 把 siliconflow 上游模型换成 `Qwen/Qwen3.5-4B` 但漏改了测试断言与 README，当前 `npm test` 红 1 个。本任务恢复绿基线。

**Files:**

- Modify: `test/chat/providers.test.ts:111`
- Modify: `README.md:76`

**Interfaces:**

- Consumes: 无
- Produces: 全绿基线（191 个测试全过），后续任务在其上构建

- [ ] **Step 1: 修正测试断言**

`test/chat/providers.test.ts` 第 111 行：

```typescript
// 改前
    expect(sent.model).toBe("Qwen/Qwen3-8B"); // 改写为上游 model
// 改后
    expect(sent.model).toBe("Qwen/Qwen3.5-4B"); // 改写为上游 model
```

- [ ] **Step 2: 跑测试验证变绿**

Run: `cd /d/projects/study/providers && npx vitest run test/chat/providers.test.ts`
Expected: 18 个测试全过（deepseek 5 + openrouter 1 + siliconflow 6 + gptsapi 6）。

- [ ] **Step 3: 同步 README 模型名**

`README.md` 第 76 行，把 `Qwen/Qwen3-8B` 改为 `Qwen/Qwen3.5-4B`（行内其余 embeddings/rerank 部分不动）：

```markdown
// 改前
| `SILICONFLOW_API_KEY` | chat 供应商 siliconflow（上游模型 Qwen/Qwen3-8B）；embeddings 供应商 siliconflow（上游模型 BAAI/bge-m3）；rerank 供应商 siliconflow（上游模型 BAAI/bge-reranker-v2-m3） |
// 改后
| `SILICONFLOW_API_KEY` | chat 供应商 siliconflow（上游模型 Qwen/Qwen3.5-4B）；embeddings 供应商 siliconflow（上游模型 BAAI/bge-m3）；rerank 供应商 siliconflow（上游模型 BAAI/bge-reranker-v2-m3） |
```

- [ ] **Step 4: 提交**

```bash
cd /d/projects/study/providers && git add test/chat/providers.test.ts README.md && git commit -m "test: sync siliconflow assertion and README model name with c344005"
```

---

### Task 2: zhipu provider + chains 注册 + 测试（TDD）

capabilities 先占位全 true（Task 3 probe 实测后校准；probeProvider 探测时临时覆盖为全 true 再恢复，占位值不影响探测结果）。

**Files:**

- Create: `src/chat/providers/zhipu.ts`
- Modify: `src/env.ts`（Env 接口补 `ZHIPU_API_KEY?: string;`，对齐现有供应商显式声明惯例）
- Modify: `src/chat/chains.ts`（import + 新链）
- Modify: `test/chat/providers.test.ts`（import + describe("zhipu") 6 条）
- Modify: `test/chat/chains.test.ts`（+1 条链顺序断言）

**Interfaces:**

- Consumes: `ChatProvider` / `ChatRequest` / `ChatResponse`（src/chat/types）、`sanitizeRequest`（src/chat/sanitize）、`NonRetryableError` / `RetryableError` / `classifyHttpStatus` / `classifyNetworkError`（src/errors）、`Env`（src/env）
- Produces: `export const zhipu: ChatProvider`（id `"zhipu"`，`capabilities: { systemPrompt, tools, jsonObject, jsonSchema }`）；`CHAINS["glm-4.7-flash"] === [zhipu, agnes, gptsapi]`；`Env.ZHIPU_API_KEY?: string`。Task 3 依赖 zhipu 已进 CHAINS。

- [ ] **Step 1: 写失败测试（providers.test.ts）**

文件顶部 import 区，`import { siliconflow } ...` 之后加：

```typescript
import { zhipu } from "../../src/chat/providers/zhipu";
```

文件末尾（gptsapi describe 之后）追加：

```typescript
describe("zhipu", () => {
  const env: Env = { AUTH_TOKENS: "", ZHIPU_API_KEY: "zp-test" };

  it("sends sanitized body with rewritten model to the zhipu endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r5", choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
      tools: [{ type: "function" }],
    };

    const res = await zhipu.chat(req, env, signal);

    expect(res).toEqual({ id: "r5", choices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("glm-4.7-flash"); // 改写为上游 model
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "s" } }); // capabilities 全 true（占位）→ 原样保留
    expect(sent.tools).toEqual([{ type: "function" }]); // tools 支持 → 保留
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer zp-test");
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(zhipu.chat(baseReq, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(zhipu.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });
});
```

- [ ] **Step 2: 写失败测试（chains.test.ts）**

现有 `describe("getChain")` 内、gpt-5.4-nano 那条 it 之后追加：

```typescript
  it("maps glm-4.7-flash to the zhipu-first chain", () => {
    expect(getChain("glm-4.7-flash").map((p) => p.id)).toEqual(["zhipu", "agnes", "gptsapi"]);
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /d/projects/study/providers && npx vitest run test/chat/providers.test.ts test/chat/chains.test.ts`
Expected: FAIL——providers.test.ts 因 `Cannot find module '../../src/chat/providers/zhipu'` 整文件失败；chains.test.ts 新增用例失败（`getChain("glm-4.7-flash")` 现返回 FALLBACK_CHAIN `["agnes"]`）。其余既有用例不受影响。

- [ ] **Step 4: 实现 zhipu.ts**

新建 `src/chat/providers/zhipu.ts`（逐行仿 siliconflow.ts）：

```typescript
import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import { sanitizeRequest } from "../sanitize";
import type { ChatProvider, ChatResponse } from "../types";

const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const UPSTREAM_MODEL = "glm-4.7-flash";
const ENV_KEY = "ZHIPU_API_KEY";

export const zhipu: ChatProvider = {
  id: "zhipu",
  // 占位全 true，待 scripts/probe.ts 实测校准（见实施计划 Task 3）
  capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true },
  async chat(req, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    const body = sanitizeRequest(req, this.capabilities);
    body.model = UPSTREAM_MODEL;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);
    try {
      return JSON.parse(text) as ChatResponse;
    } catch (err) {
      throw new RetryableError("zhipu: response is not valid JSON", { cause: err });
    }
  },
};
```

注意：缺 key 消息 `${ENV_KEY} is not configured` 的格式是硬约束，不得改动（probe.ts 正则依赖）。

- [ ] **Step 5: env.ts 声明 key**

`src/env.ts` 的 Env 接口，`GPTSAPI_API_KEY?: string;` 之后加一行：

```typescript
  ZHIPU_API_KEY?: string;
```

- [ ] **Step 6: chains.ts 注册新链**

`src/chat/chains.ts`：

import 区末尾（`import { siliconflow } ...` 之后）加：

```typescript
import { zhipu } from "./providers/zhipu";
```

CHAINS 对象，`"gpt-5.4-nano": [gptsapi, agnes, siliconflow],` 之后加：

```typescript
  "glm-4.7-flash": [zhipu, agnes, gptsapi],
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd /d/projects/study/providers && npx vitest run test/chat/providers.test.ts test/chat/chains.test.ts`
Expected: PASS——providers.test.ts 24 个（18 旧 + 6 新），chains.test.ts 4 个（3 旧 + 1 新）。

- [ ] **Step 8: typecheck**

Run: `cd /d/projects/study/providers && npm run typecheck`
Expected: 无输出，退出码 0。

- [ ] **Step 9: 提交**

```bash
cd /d/projects/study/providers && git add src/chat/providers/zhipu.ts src/env.ts src/chat/chains.ts test/chat/providers.test.ts test/chat/chains.test.ts && git commit -m "feat: add zhipu chat provider with glm-4.7-flash chain"
```

---

### Task 3: probe 实测与 capabilities 校准（真实上游请求）

**本任务有用户交互点**：probe 需要 `.dev.vars` 里的真实 ZHIPU_API_KEY（当前该文件尚无此键，用户已备好 key）。

**Files:**

- Modify: `src/chat/providers/zhipu.ts`（capabilities 终值 + 验证注释）
- Modify（条件性）: `test/chat/providers.test.ts`（仅当某能力校准为 false 时调整成功路径断言）
- Create: `docs/superpowers/reports/2026-08-20-zhipu-chat-provider-completion.md`（实测结论初稿）

**Interfaces:**

- Consumes: Task 2 的 zhipu（已进 CHAINS）、`.dev.vars` 的 `ZHIPU_API_KEY`（用户提供）
- Produces: zhipu.ts 最终 capabilities 值（Task 4 报告引用）、probe 证据记录

- [ ] **Step 1: 检查 key（用户交互点）**

Run: `cd /d/projects/study/providers && grep -c '^ZHIPU_API_KEY=' .dev.vars`
Expected: `1`。若输出 `0` 或报错：**停止本任务，向用户报告"请把智谱 API key 填入 .dev.vars 的 ZHIPU_API_KEY="并等待**，不得编造 key、不得跳过实测直接写 capabilities。

- [ ] **Step 2: 跑 probe**

Run: `cd /d/projects/study/providers && npm run probe -- zhipu`
Expected: 输出四项能力各一条（supported / rejected / inconclusive + note）与建议 capabilities。逐字记录输出（含 note）。

- [ ] **Step 3: json_schema 判别测试（必跑，无论 probe 结果如何）**

提示词与 schema 无关（提示词只让模型自我介绍，schema 却强制 fruit="banana"）——只有真执行 schema 约束才可能输出 banana：

```bash
cd /d/projects/study/providers && KEY=$(grep '^ZHIPU_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '"' | tr -d "'") && curl -sS -m 120 -w '\n---\nHTTP %{http_code} time %{time_total}s\n' -X POST "https://open.bigmodel.cn/api/paas/v4/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" --data @- <<'EOF'
{"model":"glm-4.7-flash","messages":[{"role":"user","content":"Tell me about yourself in one sentence."}],"response_format":{"type":"json_schema","json_schema":{"name":"fruit_reply","strict":true,"schema":{"type":"object","properties":{"fruit":{"type":"string","enum":["banana"]},"note":{"type":"string"}},"required":["fruit","note"],"additionalProperties":false}}}}
EOF
```

判定：`choices[0].message.content` 为合法 JSON 且含 `"fruit":"banana"` → jsonSchema=true；content 为自由文本自我介绍 → 被忽略，jsonSchema=false；HTTP 400 → 不支持该参数形状，jsonSchema=false。同时记录 `time_total` 与响应中是否出现 `reasoning_content`（默认思考行为观察）。

- [ ] **Step 4: 对每个 inconclusive 项 curl 复测（仅跑需要的）**

先提取 key（同 Step 3）。判定标准：HTTP 200 为 accepted；输出行为按各条说明判定。

systemPrompt 复测（判定：200 且 content 近似只含 `pong` → true）：

```bash
cd /d/projects/study/providers && KEY=$(grep '^ZHIPU_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '"' | tr -d "'") && curl -sS -m 120 -w '\n---\nHTTP %{http_code} time %{time_total}s\n' -X POST "https://open.bigmodel.cn/api/paas/v4/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" --data @- <<'EOF'
{"model":"glm-4.7-flash","messages":[{"role":"system","content":"You are a test bot. Reply only with the single word pong."},{"role":"user","content":"ping"}]}
EOF
```

tools 复测（判定：200 → true，与 probe 同口径 accepted 即支持；返回 tool_calls 则行为亦验证）：

```bash
cd /d/projects/study/providers && KEY=$(grep '^ZHIPU_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '"' | tr -d "'") && curl -sS -m 120 -w '\n---\nHTTP %{http_code} time %{time_total}s\n' -X POST "https://open.bigmodel.cn/api/paas/v4/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" --data @- <<'EOF'
{"model":"glm-4.7-flash","messages":[{"role":"user","content":"What is the weather in Paris? Call the get_weather tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"auto"}
EOF
```

jsonObject 复测（判定：200 且 content 为合法 JSON → true；仅 accepted 但输出非 JSON → false 并在报告注明"请求被接受但输出行为未验证"）：

```bash
cd /d/projects/study/providers && KEY=$(grep '^ZHIPU_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '"' | tr -d "'") && curl -sS -m 120 -w '\n---\nHTTP %{http_code} time %{time_total}s\n' -X POST "https://open.bigmodel.cn/api/paas/v4/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" --data @- <<'EOF'
{"model":"glm-4.7-flash","messages":[{"role":"user","content":"Return exactly this JSON object: {\"ok\": true}"}],"response_format":{"type":"json_object"}}
EOF
```

- [ ] **Step 5: 校准 capabilities**

按判定矩阵写终值（覆盖占位全 true）：

| 证据 | 终值 |
|---|---|
| probe supported（非 jsonSchema 项） | true |
| probe rejected | false |
| probe inconclusive → curl 判定 | 按 curl 结论 |
| 仍无法判定 | false（保守），报告注明需人工复核 |
| jsonSchema | 只认 Step 3 判别结果 |

同时把注释从占位说明换成验证说明（对齐 siliconflow.ts 先例，写实际结论）：

```typescript
  // 四项能力经 scripts/probe.ts 探测 + curl 判别实测验证（2026-08-20）：
  // systemPrompt=?, tools=?, jsonObject=?, jsonSchema=?（按实测结果填写，rejected/降级项写明原因）
  capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true },
```

（上面 capabilities 值按实测终值写，注释里的 ? 逐项替换为实测结论。）

- [ ] **Step 6: 条件性调整测试断言（仅当有 false 时）**

成功路径测试（Task 2 Step 1 的第 1 条）断言按降级分支调整——只改列出的行，其余不动：

jsonSchema=false 且 jsonObject=true（json_schema 降级为 json_object）：

```typescript
    expect(sent.response_format).toEqual({ type: "json_object" }); // jsonSchema 不支持 → 降级 json_object
```

jsonSchema=false 且 jsonObject=false（response_format 整个删除）：

```typescript
    expect(sent.response_format).toBeUndefined(); // 均不支持 → 删除
```

tools=false（tools 被裁剪）：

```typescript
    expect(sent.tools).toBeUndefined(); // tools 不支持 → 裁剪
```

systemPrompt=false：当前成功路径测试不含 system 消息，无需调整（与现有供应商测试口径一致）。

若四项终值均为 true：测试不改，仅更新断言行注释里的「占位」字样为「实测支持」。

- [ ] **Step 7: 验证**

Run: `cd /d/projects/study/providers && npm run typecheck && npx vitest run test/chat/providers.test.ts test/chat/chains.test.ts`
Expected: typecheck 干净；测试全过。

- [ ] **Step 8: 记录实测结论（报告初稿）**

新建 `docs/superpowers/reports/2026-08-20-zhipu-chat-provider-completion.md`，写入「probe 实测结论」部分：四项能力的 probe 原始输出、判别/复测 curl 的判定依据与结果、capabilities 终值、耗时与 reasoning_content 观察（默认思考行为）。Task 4 补全报告其余部分。

- [ ] **Step 9: 提交**

```bash
cd /d/projects/study/providers && git add src/chat/providers/zhipu.ts test/chat/providers.test.ts docs/superpowers/reports/2026-08-20-zhipu-chat-provider-completion.md && git commit -m "feat: calibrate zhipu capabilities from live probe"
```

---

### Task 4: 配置文档 + AGENTS.md checklist 顺序修正 + 全量验收

**Files:**

- Modify: `.dev.vars.example`（chat 段补 ZHIPU_API_KEY=）
- Modify: `README.md`（配置表补 zhipu 行）
- Modify: `AGENTS.md`（checklist 步骤 2/3 对调——probe 依赖 chains 注册，现有顺序不可执行，本任务实际验证了这一点）
- Modify: `docs/superpowers/reports/2026-08-20-zhipu-chat-provider-completion.md`（补全）

**Interfaces:**

- Consumes: Task 3 的最终 capabilities 与实测结论
- Produces: 完整交付（文档、报告、全绿验收）

- [ ] **Step 1: .dev.vars.example 补 key 行**

`GPTSAPI_API_KEY=` 之后加一行：

```
ZHIPU_API_KEY=
```

- [ ] **Step 2: README 配置表补行**

`README.md` 配置表，gptsapi 行之后加：

```markdown
| `ZHIPU_API_KEY` | chat 供应商 zhipu（上游模型 glm-4.7-flash） |
```

- [ ] **Step 3: AGENTS.md checklist 步骤 2/3 对调**

「新增一个 chat 供应商（checklist）」节，2、3 两项交换并补依赖说明（其余项不动）：

```markdown
2. `src/chat/chains.ts` 相应链中按降级顺序插入（probe 依赖 chains 注册：`scripts/probe.ts` 从 CHAINS 按 id 解析供应商）。
3. `npm run probe -- <providerId>` 实测四项能力（systemPrompt/tools/jsonObject/jsonSchema），按输出建议校准 `capabilities`——**能力声明必须实测确认，不得凭文档或推断写入**。注意：探测单次上限 30s，慢模型（如默认开思考模式的 Qwen3）易超时得 inconclusive，须用 curl 放宽超时复测；json_schema 要用与提示词无关的严格 schema 做判别测试，确认是真执行而非被忽略。
```

- [ ] **Step 4: 全量验收**

Run: `cd /d/projects/study/providers && npm run typecheck && npm test`
Expected: typecheck 干净；测试 **198 个全过**（191 基线 + zhipu 6 + chains 1），无失败无跳过。

- [ ] **Step 5: 补全完成报告**

`docs/superpowers/reports/2026-08-20-zhipu-chat-provider-completion.md` 在 Task 3 的实测结论之外补全：

```markdown
# 智谱 chat provider 完成报告（2026-08-20）

## 交付物
（文件清单 + 提交 hash：provider/env/chains/测试/文档/AGENTS.md 修正）

## probe 实测结论
（Task 3 已写入：四项 probe 输出、判别/复测细节、capabilities 终值、耗时与 reasoning_content 观察）

## 验收结果
（typecheck 干净 + 198/198 全绿的具体输出摘要）

## 遗留与后续
- 生产部署（范围外，另行安排）：`wrangler secret put ZHIPU_API_KEY`，git push 自动部署后线上用 `?provider=zhipu` 验证
- README 配置表缺 agnes 行（既有遗漏，未处理）
- chains.ts 逻辑 model 键名 "Qwen/Qwen3-8B" 与上游 Qwen/Qwen3.5-4B 不一致（c344005 现状，保持不动）
```

- [ ] **Step 6: 提交**

```bash
cd /d/projects/study/providers && git add .dev.vars.example README.md AGENTS.md docs/superpowers/reports/2026-08-20-zhipu-chat-provider-completion.md && git commit -m "docs: add zhipu config docs, fix provider checklist order, complete report"
```
