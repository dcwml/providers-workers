# Sensenova Chat Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第 7 家 chat 供应商商汤 SenseNova（`sensenova-6.8-flash-lite`），注册为新逻辑 model 自成链，probe 实测校准 capabilities。

**Architecture:** 逐行仿 zhipu.ts 的自包含 provider 文件（不抽公共适配器，项目明确架构选择）；CHAINS 新增一行 `[sensenova, agnes, gptsapi]`；TDD 先测试 RED 再实现 GREEN；probe 实测后校准 capabilities 并按需回改测试断言。

**Tech Stack:** TypeScript strict（`noUncheckedIndexedAccess` + `verbatimModuleSyntax`，禁 `any`）、Cloudflare Workers 运行时、vitest（上游 fetch 全 mock）。

**Spec:** `docs/superpowers/specs/2026-08-27-sensenova-chat-provider-design.md`

---

## 全局约束（每个任务都必须遵守）

- 终端是 **Windows PowerShell 5.1**：语句分隔用 `;` 不用 `&&`；没有 grep（用 `Select-String`）；curl 必须用 `curl.exe`（`curl` 是 `Invoke-WebRequest` 别名）；无 bash heredoc（JSON body 先写文件再 `--data @file`）。
- `git commit -m` 若被沙箱拦截（报 `code = 40441` 之类）：改为把 message 写入临时文件后 `git commit -F <file>`。
- TypeScript strict 禁 `any`；新代码对齐现有文件风格。
- **本计划不 push、不 deploy**（生产 secret 与 git push 验收后另行安排）。
- 每任务一个本地 commit。
- 工作目录：`d:\Projects\study\providers`。

---

### Task 1: sensenova provider TDD 实现（占位 capabilities 全 true）

**Files:**

- Create: `src/chat/providers/sensenova.ts`
- Modify: `src/env.ts`（Env 接口补一行）
- Modify: `src/chat/chains.ts`（import + 新链）
- Test: `test/chat/providers.test.ts`（import + describe("sensenova") 6 条）
- Test: `test/chat/chains.test.ts`（+1 条链顺序断言）

**Interfaces:**

- Consumes: `ChatProvider` / `ChatRequest` / `ChatResponse`（src/chat/types）、`sanitizeRequest`（src/chat/sanitize）、`NonRetryableError` / `RetryableError` / `classifyHttpStatus` / `classifyNetworkError`（src/errors）、`Env`（src/env）
- Produces: `export const sensenova: ChatProvider`（id `"sensenova"`）；`CHAINS["sensenova-6.8-flash-lite"] === [sensenova, agnes, gptsapi]`；`Env.SENSENOVA_API_KEY?: string`。Task 2 依赖 sensenova 已进 CHAINS（probe 按 id 从 CHAINS 解析）。

- [ ] **Step 1: 写失败测试（providers.test.ts）**

文件顶部 import 区，`import { siliconflow } ...` 之后（保持字母序 sensenova < siliconflow 也可，紧跟其后即可，与 zhipu 先例对齐放在 siliconflow 之后）：

```typescript
import { sensenova } from "../../src/chat/providers/sensenova";
```

文件末尾（zhipu describe 的 `});` 之后）追加：

```typescript
describe("sensenova", () => {
  const env: Env = { AUTH_TOKENS: "", SENSENOVA_API_KEY: "sn-test" };

  it("sends sanitized body with rewritten model to the sensenova endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r6", choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
      tools: [{ type: "function" }],
    };

    const res = await sensenova.chat(req, env, signal);

    expect(res).toEqual({ id: "r6", choices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://token.sensenova.cn/v1/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("sensenova-6.8-flash-lite"); // 改写为上游 model
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "s" } }); // 占位全 true；Task 2 实测校准后如有变化同步调整
    expect(sent.tools).toEqual([{ type: "function" }]); // tools 支持 → 保留
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sn-test");
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(sensenova.chat(baseReq, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(sensenova.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(sensenova.chat(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(sensenova.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(sensenova.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });
});
```

`test/chat/chains.test.ts` 的 `describe("getChain")` 内，glm-4.7-flash 断言之后追加：

```typescript
  it("maps sensenova-6.8-flash-lite to the sensenova-first chain", () => {
    expect(getChain("sensenova-6.8-flash-lite").map((p) => p.id)).toEqual(["sensenova", "agnes", "gptsapi"]);
  });
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx vitest run test/chat/providers.test.ts test/chat/chains.test.ts`
Expected: FAIL——`sensenova` 模块不存在（Cannot find module `../../src/chat/providers/sensenova`），链断言失败（getChain 返回 FALLBACK_CHAIN）。

- [ ] **Step 3: 创建 `src/chat/providers/sensenova.ts`**

逐行仿 `src/chat/providers/zhipu.ts`，完整内容：

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

const BASE_URL = "https://token.sensenova.cn/v1";
const UPSTREAM_MODEL = "sensenova-6.8-flash-lite";
const ENV_KEY = "SENSENOVA_API_KEY";

export const sensenova: ChatProvider = {
  id: "sensenova",
  // 占位全 true，待 scripts/probe.ts 实测校准（见实施计划 Task 2）
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
      throw new RetryableError("sensenova: response is not valid JSON", { cause: err });
    }
  },
};
```

注意：缺 key 错误消息必须保持 `SENSENOVA_API_KEY is not configured` 格式（probe.ts 以 `/is not configured$/` 正则区分环境问题与能力被拒，格式走样会导致 probe 误判为 rejected）。

- [ ] **Step 4: env.ts 声明 key**

`src/env.ts` Env 接口，`ZHIPU_API_KEY?: string;` 之后加一行：

```typescript
  SENSENOVA_API_KEY?: string;
```

- [ ] **Step 5: chains.ts 注册新链**

`src/chat/chains.ts` import 区加（siliconflow 与 zhipu 的 import 之间，字母序 sensenova < siliconflow 则放 siliconflow 之前，与文件头注释约定无冲突）：

```typescript
import { sensenova } from "./providers/sensenova";
```

CHAINS 对象，`"glm-4.7-flash"` 行之后加：

```typescript
  "sensenova-6.8-flash-lite": [sensenova, agnes, gptsapi],
```

FALLBACK_CHAIN 与其余四链不动。

- [ ] **Step 6: 跑测试确认 GREEN + 全量验收**

Run: `npm run typecheck; npx vitest run test/chat/providers.test.ts test/chat/chains.test.ts`
Expected: typecheck 无输出；两个测试文件全 PASS（providers 30 条、chains 5 条）。

Run: `npm test`
Expected: 22 文件 280 测试全绿（基线 273 + sensenova 6 + chains 1）。

- [ ] **Step 7: Commit**

```powershell
git add src/chat/providers/sensenova.ts src/env.ts src/chat/chains.ts test/chat/providers.test.ts test/chat/chains.test.ts; git commit -m "feat: add sensenova chat provider with sensenova-6.8-flash-lite chain"
```

（若 -m 被沙箱拦截：message 写入 tmp/commit-msg.txt 后 `git commit -F tmp/commit-msg.txt`。）

---

### Task 2: probe 实测与 capabilities 校准（真实上游请求）

**前置：`.dev.vars` 已有非空 `SENSENOVA_API_KEY`（2026-08-27 实测确认过键与值均存在）。**

**Files:**

- Modify: `src/chat/providers/sensenova.ts`（capabilities 终值 + 逐项验证注释）
- Modify（条件性）: `test/chat/providers.test.ts`（仅当某能力校准为 false 时调整成功路径断言）
- Create: `docs/superpowers/reports/2026-08-27-sensenova-chat-provider-completion.md`（实测结论初稿，Task 3 补全）

- [ ] **Step 1: 复核 key 仍非空**

Run: `(Select-String -Path .dev.vars -Pattern '^SENSENOVA_API_KEY=.+').Count`
Expected: `1`。若为 `0`：停止本任务，向用户报告"请把商汤 API key 填入 .dev.vars 的 SENSENOVA_API_KEY="并等待，不得编造 key、不得跳过实测直接写 capabilities。

- [ ] **Step 2: 跑 probe**

Run: `npm run probe -- sensenova`
Expected: 输出四项能力各一条（supported / rejected / inconclusive + note）与建议 capabilities。逐字记录输出（含 note）。
注意：探测单次上限 30s；sensenova-6.8-flash-lite 为 lite 快速模型，预期不超时；若某项 inconclusive，进入 Step 4 复测。

- [ ] **Step 3: json_schema 判别测试（必跑，无论 probe 结果如何）**

提示词与 schema 无关（提示词只让模型自我介绍，schema 却强制 fruit="banana"）——只有真执行 schema 约束才可能输出 banana。

用编辑工具创建 `tmp/sensenova-schema.json`，内容（单行或多行 JSON 均可）：

```json
{"model":"sensenova-6.8-flash-lite","messages":[{"role":"user","content":"Tell me about yourself in one sentence."}],"response_format":{"type":"json_schema","json_schema":{"name":"fruit_reply","strict":true,"schema":{"type":"object","properties":{"fruit":{"type":"string","enum":["banana"]},"note":{"type":"string"}},"required":["fruit","note"],"additionalProperties":false}}}}
```

提取 key 并发送（PowerShell，两条命令）：

```powershell
$KEY = ((Select-String -Path .dev.vars -Pattern '^SENSENOVA_API_KEY=').Line -replace '^SENSENOVA_API_KEY=','').Trim('"').Trim("'")
```

```powershell
curl.exe -sS -m 120 -w "`n---`nHTTP %{http_code} time %{time_total}s`n" -X POST "https://token.sensenova.cn/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" --data @tmp/sensenova-schema.json
```

判定：`choices[0].message.content` 为合法 JSON 且含 `"fruit":"banana"` → jsonSchema=true；content 为自由文本自我介绍 → schema 被忽略，jsonSchema=false；HTTP 400 → 不支持该参数形状，jsonSchema=false。同时记录 `time_total` 与响应结构（是否出现思考类字段）。

- [ ] **Step 4（条件）: inconclusive 项 curl 复测**

仅当 Step 2 有 inconclusive 项时执行。为每项创建 body 文件后 curl.exe 发送（命令模板同 Step 3，`-m 120` 放宽超时）。

systemPrompt 复测 body（判定：HTTP 200 且 content 近似只含 `pong` → true）：

```json
{"model":"sensenova-6.8-flash-lite","messages":[{"role":"system","content":"You are a test bot. Reply only with the single word pong."},{"role":"user","content":"ping"}]}
```

tools 复测 body（判定：HTTP 200 → true；返回 tool_calls 则行为亦验证）：

```json
{"model":"sensenova-6.8-flash-lite","messages":[{"role":"user","content":"What is the weather in Paris? Call the get_weather tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"auto"}
```

jsonObject 复测 body（判定：HTTP 200 且 content 为合法 JSON → true；仅 accepted 但输出非 JSON → false 并在报告注明"请求被接受但输出行为未验证"）：

```json
{"model":"sensenova-6.8-flash-lite","messages":[{"role":"user","content":"Return exactly this JSON object: {\"ok\": true}"}],"response_format":{"type":"json_object"}}
```

- [ ] **Step 5: 校准 capabilities**

按实测终值改写 `src/chat/providers/sensenova.ts` 的 capabilities 行。若有 false 项，仿 zhipu.ts 在 capabilities 上方写逐项验证注释（哪项实测、结论、日期）。示例（若全 true 则注释为简短的实测确认一行）：

```typescript
  // 四项能力经 scripts/probe.ts 探测 + curl 判别实测验证（2026-08-27）：
  // systemPrompt=…（复测 200，content 仅 "pong"）
  // tools=…（curl 复测 200 且实际返回 get_weather tool_calls）
  // jsonObject=…（curl 复测 200，content 为合法 JSON）
  // jsonSchema=…（判别测试：fruit 仅允许 "banana"，…）
  capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true },
```

若 jsonSchema 校准为 false：同步改 `test/chat/providers.test.ts` 成功路径断言——

```typescript
    expect(sent.response_format).toEqual({ type: "json_object" }); // jsonSchema 不支持（实测 2026-08-27）→ 降级 json_object
```

若 systemPrompt 校准为 false：成功路径测试另需验证 system 并入首条 user（对齐 sanitize 降级行为，参考 deepseekOfficial 无 systemPrompt 时的既有断言写法；当前其它供应商均支持 systemPrompt，如需此改动以 sanitize.test.ts 的合并行为为准断言 `sent.messages`）。

- [ ] **Step 6: 验收**

Run: `npm run typecheck; npm test`
Expected: typecheck 干净；22 文件 280 测试全绿。

- [ ] **Step 7: 完成报告初稿 + Commit**

创建 `docs/superpowers/reports/2026-08-27-sensenova-chat-provider-completion.md`，记录：probe 逐字输出、Step 3/4 curl 输出摘录与判定、capabilities 终值、运维观察（响应时间、思考字段、限流行为等）。

```powershell
git add src/chat/providers/sensenova.ts test/chat/providers.test.ts docs/superpowers/reports/2026-08-27-sensenova-chat-provider-completion.md; git commit -m "feat: calibrate sensenova capabilities from live probe"
```

（若无文件变化则 `git add -A` 范围内无提交物，跳过 commit 并在报告记录。）

---

### Task 3: 配置文档对齐 + 完成报告收尾

**Files:**

- Modify: `.dev.vars.example`（chat 段补一行）
- Modify: `README.md`（配置表补一行）
- Modify: `docs/superpowers/reports/2026-08-27-sensenova-chat-provider-completion.md`（补全验收结果）

- [ ] **Step 1: .dev.vars.example**

chat 段 `ZHIPU_API_KEY=` 之后加一行：

```
SENSENOVA_API_KEY=
```

- [ ] **Step 2: README.md 配置表**

`| \`ZHIPU_API_KEY\` | chat 供应商 zhipu（上游模型 glm-4.7-flash） |` 行之后加：

```markdown
| `SENSENOVA_API_KEY` | chat 供应商 sensenova（上游模型 sensenova-6.8-flash-lite） |
```

- [ ] **Step 3: 完成报告补全**

报告补：全部提交列表（`git log --oneline -4`）、验收结果（typecheck/test 输出摘录）、遗留与后续（生产部署待办：`wrangler secret put SENSENOVA_API_KEY` + git push）。

- [ ] **Step 4: 最终验收**

Run: `npm run typecheck; npm test`
Expected: typecheck 干净；22 文件 280 测试全绿，无失败无跳过。

- [ ] **Step 5: Commit**

```powershell
git add .dev.vars.example README.md docs/superpowers/reports/2026-08-27-sensenova-chat-provider-completion.md; git commit -m "docs: add sensenova config docs and completion report"
```
