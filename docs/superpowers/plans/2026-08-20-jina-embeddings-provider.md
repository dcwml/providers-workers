# Jina embeddings provider（jina / jina-embeddings-v5-omni-small）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** providers 网关 embeddings 模块新增第二家供应商 Jina（逻辑 model `jina-embeddings-v5-omni-small`，多模态输入 + `task`/`normalized` 白名单透传），并顺手修复 c344005 遗留的红基线。

**Architecture:** 自包含 provider 文件（逐行仿 `src/embeddings/providers/siliconflow.ts`，不抽公共适配器）+ `models.ts` 注册为单 provider（无链、无降级）+ `types.ts` input 类型加宽支持多模态对象。embeddings 模块现有架构零改动，siliconflow 行为完全不动。与 spec §6 实施顺序的一处偏差：**基线修复提前为 Task 1**——让后续每个任务的测试验收都基于全绿基线（c344005 的红测试会污染所有中途验收）。

**Tech Stack:** Cloudflare Workers（TypeScript strict）、vitest（全 mock 无真实网络）、curl（Task 4 真实上游实测走本机代理）。

**Spec:** `docs/superpowers/specs/2026-08-20-jina-embeddings-provider-design.md`（已批准，commit 2ae5519）

## Global Constraints

- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`；禁 `any`。
- `src/` 仅 Cloudflare Workers 运行时，无 Node API。
- 供应商自包含：**不抽公共适配器、不消除供应商间重复**（明确架构选择）。
- 响应一律原样透传（不改上游 JSON 任何字段，含 `model` / `usage`）。
- 失败分类统一口径：缺 key → `NonRetryableError`；fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`；非 JSON → `RetryableError`；`data` 空数组/非对象 → `NonRetryableError`。
- 缺 key 错误消息必须保持 `JINA_API_KEY is not configured` 格式（`is not configured$` 后缀是 probe/运维区分环境问题与能力被拒的既有契约）。
- 白名单口径：jina = OpenAI 四字段（input/encoding_format/dimensions/user）+ `task` + `normalized`（jina 专属扩展）；**siliconflow 保持四字段不动**。
- 测试全 mock 无真实网络；断言真实行为（URL/header/body/状态码/响应体），不仅断言 mock 被调用。
- 真实上游请求仅限 Task 4 的两条 curl，必须走 `-x http://127.0.0.1:7890` 代理（`api.jina.ai` 本机直连被 DNS 污染）；密钥从 `.dev.vars` 读入 shell 变量，**不得 echo、不得写入任何文件**（`.dev.vars` 已由用户更新为新 key，无需再动）。
- Bash 工具实际是 bash（非 cmd，MSYS 环境）。原生 python 读不到 MSYS `/tmp`，curl 输出文件一律用真实路径 `C:/Users/3/.qoderworkcn/workspace/mt17yeupr88v2rhx/`；python 输出加 `PYTHONIOENCODING=utf-8`。
- 本任务**不 push、不 deploy**（生产走 git push 自动部署，由用户验收后统一执行）；每任务一个本地 commit，只 `git add` 计划点名的文件。
- 工作目录：`D:\Projects\study\providers`（bash 路径 `/d/projects/study/providers`）。工作树现有 2 个 08-17 的未跟踪报告文件，与本任务无关，勿动勿提交。
- `env.ts` 无需改动：`JINA_API_KEY?: string` 已声明（read 链在用）。

---

### Task 1: siliconflow 基线修复（测试断言 + README 模型名）

c344005 把 siliconflow chat 上游模型换成 `Qwen/Qwen3.5-4B` 但漏改了测试断言与 README，当前 `npm test` 红 1 个（191 过 1 失败）。本任务恢复绿基线。

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
Expected: 18 个测试全过（siliconflow describe 6 条恢复绿）。

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

### Task 2: jina provider + input 类型加宽 + 测试（TDD）

**Files:**

- Create: `src/embeddings/providers/jina.ts`
- Modify: `src/embeddings/types.ts:3-12`（input 类型加宽）
- Modify: `test/embeddings/providers.test.ts`（import + 末尾追加 describe("jina embeddings") 9 条）

**Interfaces:**

- Consumes: `EmbeddingsProvider` / `EmbeddingsRequest` / `EmbeddingsResponse`（src/embeddings/types）、`NonRetryableError` / `RetryableError` / `classifyHttpStatus` / `classifyNetworkError`（src/errors）、`Env`（src/env，含 `JINA_API_KEY?: string` 与 string 索引签名）
- Produces: `export const jina: EmbeddingsProvider`（id `"jina"`，方法 `embed(req, env, signal): Promise<EmbeddingsResponse>`）；`EmbeddingsRequest.input: string | Array<string | { text?: string; image?: string }>`。Task 3 依赖 `jina` 导出。

- [ ] **Step 1: 写失败测试**

`test/embeddings/providers.test.ts` 顶部 import 区，`import { siliconflow } ...` 之后加：

```typescript
import { jina } from "../../src/embeddings/providers/jina";
```

文件末尾（siliconflow describe 的 `});` 之后）追加：

```typescript
describe("jina embeddings", () => {
  const env: Env = { AUTH_TOKENS: "", JINA_API_KEY: "jina-test" };

  const jinaOkBody = {
    object: "list",
    data: [
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [0.3, 0.4] },
    ],
    model: "jina-embeddings-v5-omni-small",
    usage: { prompt_tokens: 8, image_tokens: 278, total_tokens: 286 },
  };

  it("sends whitelisted body with task/normalized passthrough, rewritten model and multimodal input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, jinaOkBody));
    vi.stubGlobal("fetch", fetchMock);
    const req: EmbeddingsRequest = {
      model: "any-logical-model",
      input: [{ text: "A beautiful sunset over the beach" }, { image: "iVBORw0KGgo" }],
      task: "retrieval.query",
      normalized: true,
      encoding_format: "float",
      dimensions: 1024,
      user: "u1",
      bogus: "strip-me",
    };

    const res = await jina.embed(req, env, signal);

    expect(res).toEqual(jinaOkBody); // 响应原样透传
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.jina.ai/v1/embeddings");
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      model: "jina-embeddings-v5-omni-small", // 改写为上游固定 model
      input: [{ text: "A beautiful sunset over the beach" }, { image: "iVBORw0KGgo" }], // 多模态对象原样透传
      task: "retrieval.query", // jina 专属扩展白名单
      normalized: true, // jina 专属扩展白名单
      encoding_format: "float",
      dimensions: 1024,
      user: "u1",
    }); // bogus 字段被裁剪
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jina-test");
  });

  it("omits optional fields when absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, jinaOkBody));
    vi.stubGlobal("fetch", fetchMock);

    await jina.embed({ model: "jina-embeddings-v5-omni-small", input: ["a", "b"] }, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ model: "jina-embeddings-v5-omni-small", input: ["a", "b"] });
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      jina.embed(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps non-JSON response to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps empty data array to NonRetryableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { object: "list", data: [] })),
    );
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps non-object JSON response to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200 })));
    await expect(jina.embed(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });
});
```

说明：`baseReq`（`{ model: "BAAI/bge-m3", input: "hello" }`）可复用于错误路径——provider 不读 `req.model`（一律改写为上游 model）。

- [ ] **Step 2: 跑测试验证失败**

Run: `cd /d/projects/study/providers && npx vitest run test/embeddings/providers.test.ts`
Expected: FAIL——报错含 `Failed to resolve import` / 模块 `providers/jina` 无法解析（模块级失败会连带 siliconflow 的 9 条一起报错，属正常）。

- [ ] **Step 3: 加宽 input 类型**

`src/embeddings/types.ts` 第 4-6 行：

```typescript
// 改前
export interface EmbeddingsRequest {
  model: string;
  /** 单条文本或文本数组 */
  input: string | string[];
// 改后
export interface EmbeddingsRequest {
  model: string;
  /** 单条文本、文本数组或多模态对象数组（{text}/{image} 项，jina 上游支持图文混合） */
  input: string | Array<string | { text?: string; image?: string }>;
```

其余行（encoding_format/dimensions/user/索引签名）不动。

- [ ] **Step 4: 创建 jina provider**

新建 `src/embeddings/providers/jina.ts`，全文如下（逐行对齐 siliconflow.ts 模式，差异仅：常量三件套、白名单多 task/normalized 两行、错误消息前缀）：

```typescript
import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { EmbeddingsProvider, EmbeddingsResponse } from "../types";

const BASE_URL = "https://api.jina.ai/v1";
const UPSTREAM_MODEL = "jina-embeddings-v5-omni-small";
const ENV_KEY = "JINA_API_KEY";

export const jina: EmbeddingsProvider = {
  id: "jina",
  async embed(req, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    // OpenAI 标准字段白名单 + jina 专属 task/normalized 透传，其余字段裁剪；model 改写为上游 model
    const body: Record<string, unknown> = { model: UPSTREAM_MODEL, input: req.input };
    if (req.encoding_format !== undefined) body.encoding_format = req.encoding_format;
    if (req.dimensions !== undefined) body.dimensions = req.dimensions;
    if (req.user !== undefined) body.user = req.user;
    if (req.task !== undefined) body.task = req.task;
    if (req.normalized !== undefined) body.normalized = req.normalized;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/embeddings`, {
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new RetryableError("jina embeddings: response is not valid JSON", {
        cause: err,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NonRetryableError("jina embeddings: response has no data");
    }
    const resp = parsed as EmbeddingsResponse;
    if (!Array.isArray(resp.data) || resp.data.length === 0) {
      throw new NonRetryableError("jina embeddings: response has no data");
    }
    return resp;
  },
};
```

- [ ] **Step 5: 跑测试验证通过**

Run: `cd /d/projects/study/providers && npx vitest run test/embeddings/providers.test.ts`
Expected: 18 个测试全过（siliconflow 9 + jina 9）。

- [ ] **Step 6: typecheck**

Run: `cd /d/projects/study/providers && npm run typecheck`
Expected: 干净（`req.task` / `req.normalized` 经索引签名读取为 `unknown`，赋给 `Record<string, unknown>` 合法）。

- [ ] **Step 7: 提交**

```bash
cd /d/projects/study/providers && git add src/embeddings/providers/jina.ts src/embeddings/types.ts test/embeddings/providers.test.ts && git commit -m "feat: add jina embeddings provider with multimodal input and task passthrough"
```

---

### Task 3: models 注册 + runner 测试同步（TDD）

**Files:**

- Modify: `src/embeddings/models.ts:1-10`（import + MODELS 一行）
- Modify: `test/embeddings/runner.test.ts:24-37`（model mapping describe 内两处断言改 + 新增一条）

**Interfaces:**

- Consumes: `jina`（Task 2 产出，`EmbeddingsProvider`）
- Produces: `MODELS["jina-embeddings-v5-omni-small"] === jina`；`EMBEDDING_MODEL_IDS === ["BAAI/bge-m3", "jina-embeddings-v5-omni-small"]`；`EMBEDDINGS_PROVIDER_IDS === ["siliconflow", "jina"]`。`?provider=jina` 隔离参数经既有 `getEmbeddingsProviderById` 自动可用，无需其它改动。

- [ ] **Step 1: 更新 runner 测试**

`test/embeddings/runner.test.ts`，`describe("model mapping")` 内两处改动：

第 26 行之后（"maps BAAI/bge-m3 to siliconflow" 的 `});` 与 "returns undefined" 之间）插入：

```typescript
  it("maps jina-embeddings-v5-omni-small to jina", () => {
    expect(getEmbeddingsProviderByModel("jina-embeddings-v5-omni-small")?.id).toBe("jina");
  });
```

"exposes model ids and provider ids for error messages" 的 it 内（第 33-34 行）：

```typescript
// 改前
    expect(EMBEDDING_MODEL_IDS).toEqual(["BAAI/bge-m3"]);
    expect(EMBEDDINGS_PROVIDER_IDS).toEqual(["siliconflow"]);
// 改后
    expect(EMBEDDING_MODEL_IDS).toEqual(["BAAI/bge-m3", "jina-embeddings-v5-omni-small"]);
    expect(EMBEDDINGS_PROVIDER_IDS).toEqual(["siliconflow", "jina"]);
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd /d/projects/study/providers && npx vitest run test/embeddings/runner.test.ts`
Expected: 2 个失败——`maps jina-embeddings-v5-omni-small to jina`（实际 undefined）与 `exposes model ids...`（数组不含 jina）；其余全过。

- [ ] **Step 3: 注册 model**

`src/embeddings/models.ts`：

```typescript
// 改前
import type { EmbeddingsProvider } from "./types";
import { siliconflow } from "./providers/siliconflow";
...
export const MODELS: Record<string, EmbeddingsProvider> = {
  "BAAI/bge-m3": siliconflow,
};
// 改后
import type { EmbeddingsProvider } from "./types";
import { jina } from "./providers/jina";
import { siliconflow } from "./providers/siliconflow";
...
export const MODELS: Record<string, EmbeddingsProvider> = {
  "BAAI/bge-m3": siliconflow,
  "jina-embeddings-v5-omni-small": jina,
};
```

（import 顺序按字母排 jina 在 siliconflow 前；省略号处为文件中不变的注释与函数，均不动。）

- [ ] **Step 4: 跑测试验证通过**

Run: `cd /d/projects/study/providers && npx vitest run test/embeddings/runner.test.ts`
Expected: 全过（model mapping 4 条 + runEmbeddings 5 条）。

- [ ] **Step 5: 提交**

```bash
cd /d/projects/study/providers && git add src/embeddings/models.ts test/embeddings/runner.test.ts && git commit -m "feat: register jina-embeddings-v5-omni-small logical model"
```

---

### Task 4: 上游参数实测（dimensions / encoding_format）+ 文档三处

**Files:**

- Modify: `docs/API-embeddings.md`（请求格式表 / 白名单注意 / model 映射表 / 错误码示例 / ?provider 段 / 调用示例 / 生产现状小节）
- Modify: `README.md:11,78`
- Modify: `.dev.vars.example:17-18`

**Interfaces:**

- Consumes: Task 2/3 已上线的代码行为；`.dev.vars` 里的 `JINA_API_KEY`（已由用户更新为新 key）
- Produces: dimensions/encoding_format 实测结论（写入 API 文档与完成报告）；文档与实现一致

- [ ] **Step 1: 实测 dimensions**

```bash
cd /d/projects/study/providers
KEY=$(grep '^JINA_API_KEY=' .dev.vars | cut -d= -f2)
curl -s -x http://127.0.0.1:7890 --max-time 90 "https://api.jina.ai/v1/embeddings" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"jina-embeddings-v5-omni-small","dimensions":512,"input":["hello world"]}' \
  -o "C:/Users/3/.qoderworkcn/workspace/mt17yeupr88v2rhx/jina_dim.json" -w "HTTP:%{http_code}\n"
PYTHONIOENCODING=utf-8 python -c "
import json
d = json.load(open(r'C:/Users/3/.qoderworkcn/workspace/mt17yeupr88v2rhx/jina_dim.json'))
data = d.get('data', [])
print('data_count:', len(data))
print('dim:', len(data[0]['embedding']) if data else None)
print('usage:', d.get('usage'))
"
```

按结果三选一记录结论（Step 3 写文档用）：

- HTTP 200 且 `dim: 512` → **受支持**（Matryoshka 降维生效）
- HTTP 200 且 `dim: 1024` → **被忽略**（参数不生效）
- HTTP 4xx → **被拒绝**（网关将透传为 502 `provider_failed`）

- [ ] **Step 2: 实测 encoding_format=base64**

```bash
cd /d/projects/study/providers
KEY=$(grep '^JINA_API_KEY=' .dev.vars | cut -d= -f2)
curl -s -x http://127.0.0.1:7890 --max-time 90 "https://api.jina.ai/v1/embeddings" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"jina-embeddings-v5-omni-small","encoding_format":"base64","input":["hello world"]}' \
  -o "C:/Users/3/.qoderworkcn/workspace/mt17yeupr88v2rhx/jina_b64.json" -w "HTTP:%{http_code}\n"
PYTHONIOENCODING=utf-8 python -c "
import json
d = json.load(open(r'C:/Users/3/.qoderworkcn/workspace/mt17yeupr88v2rhx/jina_b64.json'))
data = d.get('data', [])
emb = data[0].get('embedding') if data else None
print('data_count:', len(data))
print('embedding_type:', type(emb).__name__)
print('usage:', d.get('usage'))
"
```

按结果三选一记录结论：`embedding_type: str` → **受支持**（返回 base64 字符串）；`embedding_type: list` → **被忽略**（仍返回浮点数组）；HTTP 4xx → **被拒绝**。

- [ ] **Step 3: 更新 docs/API-embeddings.md**

七处改动，全部给出成品文本：

（a）请求格式表（第 23-29 行的表格）整体替换为：

```markdown
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 逻辑 model 名，见下方映射表；`BAAI/bge-m3` 或 `jina-embeddings-v5-omni-small` |
| `input` | string / 数组 | 是 | 单条文本、文本批量，或多模态对象数组（`{"text": "..."}` / `{"image": "<url 或 base64>"}` 项，仅 jina 模型支持图文混合），均不能为空 |
| `encoding_format` | string | 否 | `float`（默认，返回浮点数组）或 `base64`；bge-m3 固定 1024 维浮点数组，jina 行为见下方注意事项 |
| `dimensions` | number | 否 | 输出维度；bge-m3 固定 1024 维不支持，jina 行为见下方注意事项 |
| `user` | string | 否 | 终端用户标识，透传 |
| `task` | string | 否 | **仅 jina**：透传给上游的场景标记（如 `retrieval.query` / `retrieval.passage`），不传走 Jina 默认行为；bge-m3 不透传此字段 |
| `normalized` | boolean | 否 | **仅 jina**：是否归一化向量，透传；bge-m3 不透传此字段 |
```

（b）注意事项列表（第 38-43 行），白名单一条改为两条：

```markdown
- 白名单裁剪——上表 OpenAI 标准四字段之外的字段一律被丢弃，不会发给上游。
- 白名单例外：`jina-embeddings-v5-omni-small` 额外透传 `task` / `normalized` 两字段（jina 专属能力）；`BAAI/bge-m3` 仍只透传标准四字段。
```

（c）注意事项末尾追加一行（按 Step 1/2 实测结论二选一，删掉不适用分支）：

```markdown
- jina 的 `dimensions` 与 `encoding_format` 实测：<支持：dimensions=512 生效返回 512 维 / encoding_format=base64 生效返回 base64 字符串>；<被忽略：两参数均被上游忽略（dimensions=512 请求仍返回 1024 维浮点数组）>；<被拒绝：上游对两参数返回 4xx，网关透传为 502 provider_failed>。
```

（d）model 映射表（「### model 映射」下）加一行：

```markdown
| `jina-embeddings-v5-omni-small` | jina | `jina-embeddings-v5-omni-small` |
```

（e）错误码速查表两行示例同步：

```markdown
// 改前
| 400 | `model_not_found` | `model not found: xxx; valid models: BAAI/bge-m3` | `model` 未注册（无回落） |
| 400 | `unknown_provider` | `unknown provider: xxx; valid providers: siliconflow` | `?provider=` 传了未知值 |
// 改后
| 400 | `model_not_found` | `model not found: xxx; valid models: BAAI/bge-m3, jina-embeddings-v5-omni-small` | `model` 未注册（无回落） |
| 400 | `unknown_provider` | `unknown provider: xxx; valid providers: siliconflow, jina` | `?provider=` 传了未知值 |
```

（f）「供应商隔离参数」段（第 117 行）：

```markdown
// 改前
当前合法取值只有 `siliconflow`，未知取值直接 400。正常业务调用不要带此参数。
// 改后
当前合法取值为 `siliconflow` 和 `jina`，未知取值直接 400。正常业务调用不要带此参数。
```

（g）调用示例末尾追加两例，生产现状小节追加一行：

```markdown
# jina：检索场景显式 task（query 端）
curl -X POST "https://api.oklapzlj.com/v1/embeddings" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"jina-embeddings-v5-omni-small","task":"retrieval.query","input":"What is deep learning?"}'
# → 200，data[0].embedding 为 1024 维向量

# jina：多模态（图文混合，input 为对象数组，与返回 data 一一对应）
curl -X POST "https://api.oklapzlj.com/v1/embeddings" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"jina-embeddings-v5-omni-small","input":[{"text":"A beautiful sunset"},{"image":"https://example.com/sunset.jpg"}]}'
# → 200；usage 区分 prompt_tokens / image_tokens
```

```markdown
- jina embeddings（2026-08-20 注册，随下一次 git push 自动部署上线）：逻辑 model `jina-embeddings-v5-omni-small`，多模态输入 + `task`/`normalized` 透传，与 read 链共用 `JINA_API_KEY`；线上验证命令见完成报告「遗留与后续」。
```

- [ ] **Step 4: 更新 README.md 两处**

第 11 行端点表：

```markdown
// 改前
| POST | `/v1/embeddings` | OpenAI 兼容 embeddings。按 `model` 映射到单个 provider（无链、无降级），响应原样透传。当前：`BAAI/bge-m3` → siliconflow。 |
// 改后
| POST | `/v1/embeddings` | OpenAI 兼容 embeddings。按 `model` 映射到单个 provider（无链、无降级），响应原样透传。当前：`BAAI/bge-m3` → siliconflow；`jina-embeddings-v5-omni-small` → jina（多模态，`task`/`normalized` 透传）。 |
```

第 78 行配置表，jina 拆出独立行：

```markdown
// 改前
| `JINA_API_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` | read 三家供应商 |
// 改后
| `JINA_API_KEY` | read 供应商 jina + embeddings 供应商 jina（上游模型 jina-embeddings-v5-omni-small）共用 |
| `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` | read 供应商 |
```

- [ ] **Step 5: 更新 .dev.vars.example**

第 17-18 行：

```markdown
// 改前
# read 供应商
JINA_API_KEY=
// 改后
# read 供应商（JINA_API_KEY 同时供 embeddings 供应商 jina 使用：上游模型 jina-embeddings-v5-omni-small）
JINA_API_KEY=
```

- [ ] **Step 6: 提交**

```bash
cd /d/projects/study/providers && git add docs/API-embeddings.md README.md .dev.vars.example && git commit -m "docs: document jina embeddings provider"
```

---

### Task 5: 全量验收 + 完成报告

**Files:**

- Create: `docs/superpowers/reports/2026-08-20-jina-embeddings-provider-completion.md`

**Interfaces:**

- Consumes: Task 1-4 全部交付物
- Produces: spec §9 验收标准逐条核验记录 + 完成报告

- [ ] **Step 1: 全量验收**

Run: `cd /d/projects/study/providers && npm run typecheck && npm test`
Expected: typecheck 干净；测试 **201 个全过**（191 基线 + jina 9 + runner 1），无失败无跳过。

- [ ] **Step 2: 确认工作树干净**

Run: `cd /d/projects/study/providers && git status --short`
Expected: 仅剩 2 个 08-17 的既有未跟踪报告文件（`docs/superpowers/reports/2026-08-17-*`），无本任务遗漏改动。

- [ ] **Step 3: 写完成报告**

`docs/superpowers/reports/2026-08-20-jina-embeddings-provider-completion.md`：

```markdown
# Jina embeddings provider 完成报告（2026-08-20）

## 交付物
（文件清单 + 每任务提交 hash：基线修复 / jina provider + types / models 注册 / 文档三处）

## 上游实测结论
（设计期实测：task 可缺省、task+normalized 生效、多模态 {text}/{image} 返回 1024 维、usage 区分 prompt_tokens/image_tokens、响应 OpenAI 风格；实施期补测：dimensions 与 encoding_format 的实测结果——Task 4 Step 1/2 的输出摘要）

## 验收结果
（typecheck 干净 + 201/201 全绿的输出摘要；spec §9 三条验收标准逐条对照）

## 遗留与后续
- 生产部署（用户执行）：git push 自动部署；线上验证三连——
  1. `curl -X POST "https://api.oklapzlj.com/v1/embeddings" -H "Authorization: Bearer <GATEWAY_TOKEN>" -H "Content-Type: application/json" -d '{"model":"jina-embeddings-v5-omni-small","task":"retrieval.query","input":"hello"}'` → 200 且 1024 维
  2. 同 body 追加 `?provider=jina` 再验一次（隔离参数路径）
  3. **/v1/read 回归**（生产 JINA_API_KEY 已换新值且 read 与 embeddings 共用）：`curl -X POST "https://api.oklapzlj.com/v1/read" -H "Authorization: Bearer <GATEWAY_TOKEN>" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'` → 200，确认 read 链未受换 key 影响
- 本 key 已出现在聊天记录，如介意可在 Jina 后台轮换（更新 .dev.vars 与生产 secret 即可，代码不动）
- zhipu chat 任务照常排队（其计划中「基线修复」步骤已由本任务完成，届时跳过）
- README 配置表缺 agnes 行（既有遗漏，未处理）
```

- [ ] **Step 4: 提交**

```bash
cd /d/projects/study/providers && git add docs/superpowers/reports/2026-08-20-jina-embeddings-provider-completion.md && git commit -m "docs: add jina embeddings provider completion report"
```
