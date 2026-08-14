# Providers 网关实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cloudflare Workers 上构建多供应商聚合网关：OpenAI 兼容非流式 chat 接口（按 model 写死供应商链、自动重试与降级）+ 页面读取接口（jina → tavily → firecrawl 固定链）。

**Architecture:** 原生 fetch handler 入口做 Bearer 鉴权与路由；两个功能共用 runner 模式（供应商链顺序执行 + 通用重试引擎 `withRetry`）；每家供应商一个独立实现文件，自行按能力属性裁剪请求；上游全部为 OpenAI 兼容协议。

**Tech Stack:** TypeScript（strict）、Cloudflare Workers（wrangler）、vitest（单测，全部 mock 上游 HTTP）、无任何运行时依赖。

**规格文档：** `docs/superpowers/specs/2026-08-14-providers-gateway-design.md`

## Global Constraints

以下约束来自规格文档，所有任务隐式遵守：

- 运行环境仅 Cloudflare Workers；代码只使用 Web 标准 API（fetch/Request/Response/crypto.subtle 等），不使用 Node 专有模块。
- 每家供应商最多请求 **3 次**（重试 2 次），重试间隔 **1 秒**。
- 单次上游请求超时 **30 秒**。
- 失败判定：网络错/超时/5xx/429 → 可重试；其它 4xx → 不重试但仍换下一家供应商。
- chat 响应**原样透传**上游 JSON，`model` 字段不改写；但供应商**发往上游的请求**必须把 `model` 改写为自己写死的上游 model 名。
- 能力裁剪：不支持 tools → 删 `tools`/`tool_choice`；不支持 json_object → 删 `response_format`；不支持 json_schema → 支持 json_object 则降级为 `{type:"json_object"}`，否则删除；不支持 system → system 内容按原顺序拼接后合并进第一条 user 消息（置于其内容之前换行分隔；无 user 消息则作为新的第一条 user 消息插入；合并后移除原 system 消息）。
- read 接口：`POST /v1/read` body `{url}`，成功返回 `Content-Type: text/markdown; charset=utf-8` 的 Markdown 正文；供应商链写死 jina → tavily → firecrawl；空内容视为失败换下家。
- 网关鉴权：`Authorization: Bearer <token>`，`env.AUTH_TOKENS` 逗号分隔多 token，恒时比较。
- 错误响应：chat 用 `{error:{message,type,code}}` 风格；read 用 `{error:{message}}`。
- 日志：每次上游尝试输出 `[chat|read] provider=xxx attempt=N result=ok|retry|fatal elapsed=Nms`。
- 首批 chat 供应商为**示例**（openrouter、deepseek-official），逻辑 model 名 `sample-chat` / `sample-reasoning`，用户实现时替换。

---

### Task 1: 项目脚手架与工具链冒烟

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `wrangler.toml`
- Create: `.dev.vars.example`
- Create: `test/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm test` / `npm run typecheck` / `npm run dev` 三个命令可用；后续所有任务依赖此工具链。

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "providers",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250801.0",
    "typescript": "^5.6.0",
    "vitest": "^3.2.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "test"]
}
```

说明：类型环境用 workers-types（Node 22 运行时自带 Request/Response/crypto 全局对象，vitest 可正常跑；测试代码只使用 Web 标准 API）。

- [ ] **Step 3: 创建 vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: 创建 wrangler.toml**

```toml
name = "providers"
main = "src/index.ts"
compatibility_date = "2026-07-01"
```

- [ ] **Step 5: 创建 .dev.vars.example**

```
# 复制为 .dev.vars 后填写（.dev.vars 已被 gitignore，勿提交真实密钥）
# 生产环境用 wrangler secret put <KEY> 逐个配置

AUTH_TOKENS=change-me-token-1,change-me-token-2

# chat 供应商（每个 provider 文件声明自己读哪个变量）
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=

# read 供应商
JINA_API_KEY=
TAVILY_API_KEY=
FIRECRAWL_API_KEY=
```

- [ ] **Step 6: 更新 .gitignore（追加）**

在现有内容后追加：

```
.dev.vars
.wrangler/
dist/
```

- [ ] **Step 7: 安装依赖**

Run: `cd "D:\Projects\study\providers" && npm install`
Expected: 安装成功，生成 node_modules 与 package-lock.json。

- [ ] **Step 8: 写冒烟测试验证工具链**

Create `test/smoke.test.ts`（保留为长期工具链金丝雀）：

```ts
import { describe, expect, it } from "vitest";

describe("toolchain smoke", () => {
  it("vitest runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 9: 运行验证**

Run: `npm test`
Expected: 1 个测试文件、1 个用例通过。

Run: `npx tsc --noEmit`
Expected: 无输出无报错（此时 src 为空，include 允许空目录）。

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts wrangler.toml .dev.vars.example .gitignore test/smoke.test.ts
git commit -m "chore: scaffold workers project with typescript, vitest, wrangler"
```

---

### Task 2: 错误分类模块 errors.ts

**Files:**
- Create: `src/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Produces:
  - `class RetryableError extends Error` —— 可重试错误（网络错/超时/5xx/429），`withRetry` 只重试它。
  - `class NonRetryableError extends Error` —— 不可重试错误（其它 4xx、缺 key、空内容），立即交给 runner 换下家。
  - `classifyHttpStatus(status: number, bodyText: string): RetryableError | NonRetryableError`
  - `classifyNetworkError(err: unknown): RetryableError`
  - `interface ProviderError { provider: string; message: string }` —— runner 聚合错误用。

- [ ] **Step 1: 写失败测试**

Create `test/errors.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../src/errors";

describe("classifyHttpStatus", () => {
  it("treats 429 as retryable", () => {
    expect(classifyHttpStatus(429, "rate limited")).toBeInstanceOf(RetryableError);
  });

  it("treats 5xx as retryable", () => {
    expect(classifyHttpStatus(500, "boom")).toBeInstanceOf(RetryableError);
    expect(classifyHttpStatus(503, "unavailable")).toBeInstanceOf(RetryableError);
  });

  it("treats other 4xx as non-retryable", () => {
    expect(classifyHttpStatus(400, "bad request")).toBeInstanceOf(NonRetryableError);
    expect(classifyHttpStatus(401, "unauthorized")).toBeInstanceOf(NonRetryableError);
    expect(classifyHttpStatus(403, "forbidden")).toBeInstanceOf(NonRetryableError);
  });

  it("includes status and truncated body snippet in message", () => {
    const err = classifyHttpStatus(500, "x".repeat(500));
    expect(err.message).toContain("500");
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("classifyNetworkError", () => {
  it("wraps an Error into RetryableError keeping its message", () => {
    const err = classifyNetworkError(new TypeError("fetch failed"));
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.message).toContain("fetch failed");
  });

  it("wraps non-Error values", () => {
    expect(classifyNetworkError("weird").message).toContain("weird");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/errors.test.ts`
Expected: FAIL，提示无法解析 `../src/errors`。

- [ ] **Step 3: 实现 src/errors.ts**

```ts
export class RetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableError";
  }
}

export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** runner 聚合各家失败时使用的结构 */
export interface ProviderError {
  provider: string;
  message: string;
}

const BODY_SNIPPET_MAX = 300;

/** 按上游 HTTP 状态分类：429/5xx 可重试，其它 4xx 不可重试。 */
export function classifyHttpStatus(
  status: number,
  bodyText: string,
): RetryableError | NonRetryableError {
  const snippet = bodyText.slice(0, BODY_SNIPPET_MAX);
  const message = `upstream ${status}: ${snippet}`;
  if (status === 429 || status >= 500) return new RetryableError(message);
  return new NonRetryableError(message);
}

/** fetch 抛出的网络层错误（含超时 abort）一律可重试。 */
export function classifyNetworkError(err: unknown): RetryableError {
  const detail = err instanceof Error ? err.message : String(err);
  return new RetryableError(`network error: ${detail}`, { cause: err });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/errors.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: add retryable/non-retryable error classification"
```

---

### Task 3: 通用重试引擎 retry.ts

**Files:**
- Create: `src/retry.ts`
- Test: `test/retry.test.ts`

**Interfaces:**
- Consumes: `RetryableError`（来自 `src/errors.ts`）
- Produces:
  - `interface AttemptInfo { attempt: number; result: "ok" | "retry" | "fatal"; elapsedMs: number; error?: unknown }`（attempt 从 1 开始）
  - `interface RetryOptions { maxAttempts?: number; delayMs?: number; onAttempt?: (info: AttemptInfo) => void }`（默认 maxAttempts=3、delayMs=1000）
  - `withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>` —— 只重试 `RetryableError`；重试耗尽抛最后错误；非可重试错误立即抛出。
  - `sleep(ms: number): Promise<void>`

- [ ] **Step 1: 写失败测试**

Create `test/retry.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../src/errors";
import { withRetry, type AttemptInfo } from "../src/retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first successful result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries RetryableError up to 3 attempts then throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("boom"));
    const p = withRetry(fn, { delayMs: 1000 });
    p.catch(() => {}); // 挂住 rejection，避免 unhandled 警告
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("waits delayMs between attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("boom"));
    const p = withRetry(fn, { delayMs: 1000 });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("succeeds after transient failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("1"))
      .mockRejectedValueOnce(new RetryableError("2"))
      .mockResolvedValue("done");
    const p = withRetry(fn, { delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry NonRetryableError", async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError("bad"));
    await expect(withRetry(fn)).rejects.toThrow("bad");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("x"));
    const p = withRetry(fn, { maxAttempts: 5, delayMs: 10 });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(40);
    await expect(p).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("reports per-attempt results via onAttempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("x"))
      .mockResolvedValue("ok");
    const seen: AttemptInfo[] = [];
    const p = withRetry(fn, { delayMs: 1000, onAttempt: (info) => seen.push(info) });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(seen.map((s) => s.result)).toEqual(["retry", "ok"]);
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen[0]?.error).toBeInstanceOf(RetryableError);
    expect(seen[1]?.error).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/retry.test.ts`
Expected: FAIL，无法解析 `../src/retry`。

- [ ] **Step 3: 实现 src/retry.ts**

```ts
import { RetryableError } from "./errors";

export interface AttemptInfo {
  /** 第几次尝试，从 1 开始 */
  attempt: number;
  /** ok=成功；retry=可重试失败将重试；fatal=最后一次失败或不可重试 */
  result: "ok" | "retry" | "fatal";
  elapsedMs: number;
  error?: unknown;
}

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 两次尝试之间的等待毫秒数，默认 1000 */
  delayMs?: number;
  onAttempt?: (info: AttemptInfo) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 只重试 RetryableError；其它错误立即抛出。
 * 重试耗尽后抛出最后一次的错误。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 1000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const value = await fn();
      options.onAttempt?.({ attempt, result: "ok", elapsedMs: Date.now() - start });
      return value;
    } catch (err) {
      const elapsedMs = Date.now() - start;
      if (err instanceof RetryableError && attempt < maxAttempts) {
        options.onAttempt?.({ attempt, result: "retry", elapsedMs, error: err });
        lastError = err;
        await sleep(delayMs);
        continue;
      }
      options.onAttempt?.({ attempt, result: "fatal", elapsedMs, error: err });
      throw err;
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/retry.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add src/retry.ts test/retry.test.ts
git commit -m "feat: add generic retry engine with attempt reporting"
```

---

### Task 4: Bearer 鉴权 auth.ts

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Produces: `isAuthorized(request: Request, tokensCsv: string): Promise<boolean>` —— 解析 `Authorization: Bearer <token>`，与逗号分隔的 token 列表做恒时比较（SHA-256 后逐字节 XOR，兼容 Workers 与 Node 测试环境，不依赖 Workers 私有的 `crypto.subtle.timingSafeEqual`）。

- [ ] **Step 1: 写失败测试**

Create `test/auth.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth";

function makeRequest(auth?: string): Request {
  const headers = new Headers();
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request("https://gateway.example/v1/read", { headers });
}

describe("isAuthorized", () => {
  it("accepts a valid token", async () => {
    expect(await isAuthorized(makeRequest("Bearer secret-1"), "secret-1")).toBe(true);
  });

  it("accepts one of multiple comma-separated tokens (with padding spaces)", async () => {
    expect(await isAuthorized(makeRequest("Bearer b"), "a, b ,c")).toBe(true);
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    expect(await isAuthorized(makeRequest("bearer secret-1"), "secret-1")).toBe(true);
  });

  it("rejects a wrong token", async () => {
    expect(await isAuthorized(makeRequest("Bearer nope"), "secret-1")).toBe(false);
  });

  it("rejects a missing authorization header", async () => {
    expect(await isAuthorized(makeRequest(), "secret-1")).toBe(false);
  });

  it("rejects a non-Bearer scheme", async () => {
    expect(await isAuthorized(makeRequest("Basic secret-1"), "secret-1")).toBe(false);
  });

  it("rejects when token list is empty", async () => {
    expect(await isAuthorized(makeRequest("Bearer x"), " , ")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL，无法解析 `../src/auth`。

- [ ] **Step 3: 实现 src/auth.ts**

```ts
async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** 恒时字符串比较：先各自 SHA-256 定长，再逐字节 XOR 累计，避免时序侧信道。 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  }
  return diff === 0;
}

export async function isAuthorized(request: Request, tokensCsv: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return false;
  const provided = match[1].trim();
  if (provided.length === 0) return false;

  const tokens = tokensCsv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  for (const token of tokens) {
    if (await constantTimeEquals(provided, token)) return true;
  }
  return false;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/auth.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: add bearer token auth with constant-time comparison"
```

---

### Task 5: chat 类型与请求裁剪 types.ts + sanitize.ts

**Files:**
- Create: `src/env.ts`
- Create: `src/chat/types.ts`
- Create: `src/chat/sanitize.ts`
- Test: `test/chat/sanitize.test.ts`

**Interfaces:**
- Produces:
  - `src/env.ts`：`interface Env { AUTH_TOKENS: string; OPENROUTER_API_KEY?: string; DEEPSEEK_API_KEY?: string; JINA_API_KEY?: string; TAVILY_API_KEY?: string; FIRECRAWL_API_KEY?: string; [key: string]: string | undefined }`
  - `src/chat/types.ts`：
    - `type ChatRole = "system" | "user" | "assistant" | "tool"`
    - `interface ChatMessage { role: ChatRole; content: string | unknown[]; [key: string]: unknown }`
    - `interface ResponseFormat { type: string; json_schema?: unknown }`
    - `interface ChatRequest { model: string; messages: ChatMessage[]; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; response_format?: ResponseFormat; [key: string]: unknown }`
    - `type ChatResponse = Record<string, unknown>`
    - `interface Capabilities { systemPrompt: boolean; tools: boolean; jsonObject: boolean; jsonSchema: boolean }`
    - `interface ChatProvider { id: string; capabilities: Capabilities; chat(req: ChatRequest, env: Env, signal: AbortSignal): Promise<ChatResponse> }`
  - `src/chat/sanitize.ts`：
    - `sanitizeRequest(req: ChatRequest, caps: Capabilities): ChatRequest`（不改动入参，返回深拷贝裁剪结果）
    - `mergeSystem(messages: ChatMessage[]): ChatMessage[]`（导出供测试）

- [ ] **Step 1: 创建 src/env.ts**

```ts
export interface Env {
  AUTH_TOKENS: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  JINA_API_KEY?: string;
  TAVILY_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  /** 允许供应商声明各自的其它 key 名 */
  [key: string]: string | undefined;
}
```

- [ ] **Step 2: 创建 src/chat/types.ts**

```ts
import type { Env } from "../env";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  /** 文本消息为 string；多模态等场景可能为数组 */
  content: string | unknown[];
  [key: string]: unknown;
}

export interface ResponseFormat {
  type: string;
  json_schema?: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: ResponseFormat;
  /** 其余 OpenAI 字段原样透传 */
  [key: string]: unknown;
}

export type ChatResponse = Record<string, unknown>;

export interface Capabilities {
  systemPrompt: boolean;
  tools: boolean;
  jsonObject: boolean;
  jsonSchema: boolean;
}

export interface ChatProvider {
  id: string;
  capabilities: Capabilities;
  chat(req: ChatRequest, env: Env, signal: AbortSignal): Promise<ChatResponse>;
}
```

- [ ] **Step 3: 写失败测试**

Create `test/chat/sanitize.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { mergeSystem, sanitizeRequest } from "../../src/chat/sanitize";
import type { Capabilities, ChatRequest } from "../../src/chat/types";

const ALL: Capabilities = { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true };
const NONE: Capabilities = { systemPrompt: false, tools: false, jsonObject: false, jsonSchema: false };

describe("sanitizeRequest", () => {
  it("removes tools and tool_choice when tools not supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f" } }],
      tool_choice: "auto",
    };
    const out = sanitizeRequest(req, { ...ALL, tools: false });
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(req.tools).toHaveLength(1); // 入参未被修改
  });

  it("keeps tools when supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function" }],
      tool_choice: "auto",
    };
    const out = sanitizeRequest(req, ALL);
    expect(out.tools).toEqual([{ type: "function" }]);
    expect(out.tool_choice).toBe("auto");
  });

  it("removes response_format json_object when not supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [],
      response_format: { type: "json_object" },
    };
    expect(sanitizeRequest(req, { ...ALL, jsonObject: false }).response_format).toBeUndefined();
  });

  it("downgrades json_schema to json_object when only json_object supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [],
      response_format: { type: "json_schema", json_schema: { name: "s" } },
    };
    const out = sanitizeRequest(req, { ...ALL, jsonSchema: false });
    expect(out.response_format).toEqual({ type: "json_object" });
  });

  it("removes json_schema when neither format supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [],
      response_format: { type: "json_schema" },
    };
    const out = sanitizeRequest(req, { ...ALL, jsonSchema: false, jsonObject: false });
    expect(out.response_format).toBeUndefined();
  });

  it("keeps json_schema untouched when supported", () => {
    const rf = { type: "json_schema", json_schema: { name: "s" } };
    const req: ChatRequest = { model: "m", messages: [], response_format: rf };
    expect(sanitizeRequest(req, ALL).response_format).toEqual(rf);
  });

  it("keeps response_format type text regardless of capabilities", () => {
    const req: ChatRequest = { model: "m", messages: [], response_format: { type: "text" } };
    expect(sanitizeRequest(req, NONE).response_format).toEqual({ type: "text" });
  });

  it("merges system into first user message when systemPrompt not supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    };
    const out = sanitizeRequest(req, { ...ALL, systemPrompt: false });
    expect(out.messages).toEqual([{ role: "user", content: "be brief\nhi" }]);
  });
});

describe("mergeSystem", () => {
  it("merges all system messages into the first user message in original order", () => {
    const out = mergeSystem([
      { role: "system", content: "s1" },
      { role: "user", content: "hello" },
      { role: "system", content: "s2" },
    ]);
    expect(out).toEqual([{ role: "user", content: "s1\ns2\nhello" }]);
  });

  it("returns messages unchanged when no system message", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    expect(mergeSystem(msgs)).toEqual(msgs);
  });

  it("inserts a new user message when no user message exists", () => {
    const out = mergeSystem([
      { role: "system", content: "s1" },
      { role: "assistant", content: "a" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "s1" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("inserts a new user message when first user content is not a string", () => {
    const out = mergeSystem([
      { role: "system", content: "s1" },
      { role: "user", content: [{ type: "text", text: "image caption" }] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "s1" });
    expect(out[1]?.content).toEqual([{ type: "text", text: "image caption" }]);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `npx vitest run test/chat/sanitize.test.ts`
Expected: FAIL，无法解析 `../../src/chat/sanitize`。

- [ ] **Step 5: 实现 src/chat/sanitize.ts**

```ts
import type { Capabilities, ChatMessage, ChatRequest, ResponseFormat } from "./types";

function adjustResponseFormat(
  rf: ResponseFormat,
  caps: Capabilities,
): ResponseFormat | undefined {
  if (rf.type === "json_schema") {
    if (caps.jsonSchema) return rf;
    if (caps.jsonObject) return { type: "json_object" };
    return undefined;
  }
  if (rf.type === "json_object") {
    return caps.jsonObject ? rf : undefined;
  }
  return rf; // "text" 等其它类型不受能力开关约束
}

/**
 * 把所有 system 消息按原顺序拼接，合并进第一条 user 消息；
 * 无 user 消息（或首条 user 的 content 不是字符串）时，作为新的第一条 user 消息插入。
 */
export function mergeSystem(messages: ChatMessage[]): ChatMessage[] {
  const systems = messages.filter((m) => m.role === "system");
  if (systems.length === 0) return messages;

  const systemText = systems
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  const rest = messages.filter((m) => m.role !== "system");
  const firstUser = rest.find((m) => m.role === "user");

  if (firstUser && typeof firstUser.content === "string") {
    return rest.map((m) =>
      m === firstUser ? { ...m, content: `${systemText}\n${firstUser.content}` } : m,
    );
  }
  return [{ role: "user", content: systemText }, ...rest];
}

/** 按供应商能力裁剪 OpenAI 请求；不修改入参。 */
export function sanitizeRequest(req: ChatRequest, caps: Capabilities): ChatRequest {
  const out = structuredClone(req);

  if (!caps.tools) {
    delete out.tools;
    delete out.tool_choice;
  }

  if (out.response_format !== undefined) {
    const adjusted = adjustResponseFormat(out.response_format, caps);
    if (adjusted === undefined) delete out.response_format;
    else out.response_format = adjusted;
  }

  if (!caps.systemPrompt) {
    out.messages = mergeSystem(out.messages);
  }

  return out;
}
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run test/chat/sanitize.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 7: Commit**

```bash
git add src/env.ts src/chat/types.ts src/chat/sanitize.ts test/chat/sanitize.test.ts
git commit -m "feat: add chat types and capability-based request sanitization"
```

---

### Task 6: chat 示例供应商 providers/

**Files:**
- Create: `src/chat/providers/openrouter.ts`
- Create: `src/chat/providers/deepseek-official.ts`
- Test: `test/chat/providers.test.ts`

**Interfaces:**
- Consumes: `ChatProvider/ChatRequest/ChatResponse`（types.ts）、`sanitizeRequest`（sanitize.ts）、`Env`（env.ts）、`RetryableError/NonRetryableError/classifyHttpStatus/classifyNetworkError`（errors.ts）
- Produces:
  - `openrouter: ChatProvider` —— id `"openrouter"`，base url `https://openrouter.ai/api/v1`，上游 model `openai/gpt-4o-mini`，读 `env.OPENROUTER_API_KEY`，能力全 true。
  - `deepseekOfficial: ChatProvider` —— id `"deepseek-official"`，base url `https://api.deepseek.com`，上游 model `deepseek-chat`，读 `env.DEPSEEK_API_KEY`，能力 `{ systemPrompt: true, tools: true, jsonObject: true, jsonSchema: false }`。
  - 两家均为示例，用户后续可按同样模板增删供应商文件。

每个 provider 的固定流程：缺 key → `NonRetryableError`；`sanitizeRequest` 裁剪 → **改写 body.model 为上游 model 名** → fetch（透传 signal）→ fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`；响应非 JSON → `RetryableError`；成功返回解析后的 JSON。

- [ ] **Step 1: 实现 src/chat/providers/openrouter.ts**

```ts
import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import { sanitizeRequest } from "../sanitize";
import type { ChatProvider, ChatResponse } from "../types";

const BASE_URL = "https://openrouter.ai/api/v1";
const UPSTREAM_MODEL = "openai/gpt-4o-mini";
const ENV_KEY = "OPENROUTER_API_KEY";

export const openrouter: ChatProvider = {
  id: "openrouter",
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
      throw new RetryableError("openrouter: response is not valid JSON", { cause: err });
    }
  },
};
```

- [ ] **Step 2: 实现 src/chat/providers/deepseek-official.ts**

```ts
import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import { sanitizeRequest } from "../sanitize";
import type { ChatProvider, ChatResponse } from "../types";

const BASE_URL = "https://api.deepseek.com";
const UPSTREAM_MODEL = "deepseek-chat";
const ENV_KEY = "DEEPSEEK_API_KEY";

export const deepseekOfficial: ChatProvider = {
  id: "deepseek-official",
  capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: false },
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
      throw new RetryableError("deepseek-official: response is not valid JSON", { cause: err });
    }
  },
};
```

- [ ] **Step 3: 写测试**

Create `test/chat/providers.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { deepseekOfficial } from "../../src/chat/providers/deepseek-official";
import { openrouter } from "../../src/chat/providers/openrouter";
import type { ChatRequest } from "../../src/chat/types";
import type { Env } from "../../src/env";

const baseReq: ChatRequest = {
  model: "sample-chat",
  messages: [{ role: "user", content: "hi" }],
};
const signal = new AbortController().signal;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deepseekOfficial", () => {
  const env: Env = { AUTH_TOKENS: "", DEEPSEEK_API_KEY: "sk-test" };

  it("sends sanitized body with rewritten model to hardcoded upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r1", choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
      tools: [{ type: "function" }],
    };

    const res = await deepseekOfficial.chat(req, env, signal);

    expect(res).toEqual({ id: "r1", choices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("deepseek-chat"); // 改写为上游 model
    expect(sent.response_format).toEqual({ type: "json_object" }); // jsonSchema 不支持 → 降级
    expect(sent.tools).toEqual([{ type: "function" }]); // tools 支持 → 保留
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("throws NonRetryableError when api key is not configured", async () => {
    await expect(
      deepseekOfficial.chat(baseReq, { AUTH_TOKENS: "" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    await expect(deepseekOfficial.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });

  it("maps 400 to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    await expect(deepseekOfficial.chat(baseReq, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps network failure to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(deepseekOfficial.chat(baseReq, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("openrouter", () => {
  const env: Env = { AUTH_TOKENS: "", OPENROUTER_API_KEY: "or-test" };

  it("keeps json_schema as-is and uses the openrouter endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "r2" }));
    vi.stubGlobal("fetch", fetchMock);
    const req: ChatRequest = {
      ...baseReq,
      response_format: { type: "json_schema", json_schema: { name: "s" } },
    };

    await openrouter.chat(req, env, signal);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("openai/gpt-4o-mini");
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "s" } });
  });
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/chat/providers.test.ts`
Expected: 全部 PASS（测试先行：本任务实现与测试同批，若先跑应失败于模块不存在）。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add src/chat/providers/ test/chat/providers.test.ts
git commit -m "feat: add example chat providers (openrouter, deepseek-official)"
```

---

### Task 7: chat 编排 config.ts + log.ts + chains.ts + runner.ts

**Files:**
- Create: `src/config.ts`
- Create: `src/log.ts`
- Create: `src/chat/chains.ts`
- Create: `src/chat/runner.ts`
- Test: `test/chat/runner.test.ts`

**Interfaces:**
- Consumes: `withRetry/RetryOptions`（retry.ts）、`ChatProvider/ChatRequest`（chat/types.ts）、`openrouter/deepseekOfficial`（providers/）、`Env`（env.ts）、`ProviderError`（errors.ts）
- Produces:
  - `src/config.ts`：`UPSTREAM_TIMEOUT_MS = 30_000`；`DEFAULT_RETRY = { maxAttempts: 3, delayMs: 1000 }`
  - `src/log.ts`：`logAttempt(feature: "chat" | "read", provider: string, info: AttemptInfo): void`，输出 `[chat] provider=p1 attempt=1 result=ok elapsed=123ms`（有 error 时追加 `error="..."`）
  - `src/chat/chains.ts`：`CHAINS: Record<string, readonly ChatProvider[]>`（示例：`"sample-chat": [openrouter, deepseekOfficial]`、`"sample-reasoning": [deepseekOfficial, openrouter]`）；`getChain(model: string): readonly ChatProvider[] | undefined`
  - `src/chat/runner.ts`：
    - `interface ChatOutcome { kind: "model-not-found" | "ok" | "all-failed"; status: number; body?: unknown; errors?: ProviderError[] }`
    - `runChat(req: ChatRequest, env: Env, retryOverrides?: Partial<RetryOptions>): Promise<ChatOutcome>` —— 未知 model → `{kind:"model-not-found", status:404}`；逐家 `withRetry`（每次尝试新建 `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`，`onAttempt` 接 `logAttempt`）；任一家成功 → `{kind:"ok", status:200, body}`；全链失败 → `{kind:"all-failed", status:502, errors:[...]}`

- [ ] **Step 1: 创建 src/config.ts**

```ts
export const UPSTREAM_TIMEOUT_MS = 30_000;

export const DEFAULT_RETRY = {
  maxAttempts: 3,
  delayMs: 1000,
} as const;
```

- [ ] **Step 2: 创建 src/log.ts**

```ts
import type { AttemptInfo } from "./retry";

export function logAttempt(
  feature: "chat" | "read",
  provider: string,
  info: AttemptInfo,
): void {
  const errPart =
    info.error !== undefined
      ? ` error="${info.error instanceof Error ? info.error.message : String(info.error)}"`
      : "";
  console.log(
    `[${feature}] provider=${provider} attempt=${info.attempt} result=${info.result} elapsed=${info.elapsedMs}ms${errPart}`,
  );
}
```

- [ ] **Step 3: 创建 src/chat/chains.ts**

```ts
import type { ChatProvider } from "./types";
import { deepseekOfficial } from "./providers/deepseek-official";
import { openrouter } from "./providers/openrouter";

/**
 * 逻辑 model → 供应商调用顺序（写死）。
 * 首批为示例配置，按需在 providers/ 增删供应商文件后在此调整。
 */
export const CHAINS: Record<string, readonly ChatProvider[]> = {
  "sample-chat": [openrouter, deepseekOfficial],
  "sample-reasoning": [deepseekOfficial, openrouter],
};

export function getChain(model: string): readonly ChatProvider[] | undefined {
  return CHAINS[model];
}
```

- [ ] **Step 4: 写 runner 失败测试**

Create `test/chat/runner.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { runChat } from "../../src/chat/runner";
import type { ChatProvider, ChatResponse } from "../../src/chat/types";
import type { Env } from "../../src/env";

const state = vi.hoisted(() => ({
  chains: {} as Record<string, ChatProvider[]>,
}));

vi.mock("../../src/chat/chains", () => ({
  getChain: (model: string) => state.chains[model],
}));

const env: Env = { AUTH_TOKENS: "" };
const req = { model: "m1", messages: [{ role: "user" as const, content: "hi" }] };
const fast = { delayMs: 0 }; // 测试中跳过 1s 等待

function provider(id: string, chat: ChatProvider["chat"]): ChatProvider {
  return {
    id,
    capabilities: { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true },
    chat,
  };
}

describe("runChat", () => {
  beforeEach(() => {
    state.chains = {};
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 outcome for unknown model", async () => {
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "model-not-found", status: 404 });
  });

  it("returns first provider's response on success (pass-through)", async () => {
    const body: ChatResponse = { id: "x", choices: [] };
    state.chains.m1 = [provider("p1", async () => body)];
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200, body });
  });

  it("falls back to next provider after retries are exhausted", async () => {
    let p1Calls = 0;
    state.chains.m1 = [
      provider("p1", async () => {
        p1Calls++;
        throw new RetryableError("down");
      }),
      provider("p2", async () => ({ id: "y" })),
    ];
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200 });
    expect(p1Calls).toBe(3);
  });

  it("moves to next provider without retrying on NonRetryableError", async () => {
    let p1Calls = 0;
    state.chains.m1 = [
      provider("p1", async () => {
        p1Calls++;
        throw new NonRetryableError("bad request");
      }),
      provider("p2", async () => ({ id: "z" })),
    ];
    const outcome = await runChat(req, env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200 });
    expect(p1Calls).toBe(1);
  });

  it("returns 502 with aggregated errors when whole chain fails", async () => {
    state.chains.m1 = [
      provider("p1", async () => {
        throw new RetryableError("p1 dead");
      }),
      provider("p2", async () => {
        throw new NonRetryableError("p2 refused");
      }),
    ];
    const outcome = await runChat(req, env, fast);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "p1", message: "p1 dead" },
      { provider: "p2", message: "p2 refused" },
    ]);
  });

  it("logs each attempt", async () => {
    state.chains.m1 = [provider("p1", async () => ({ id: "ok" }))];
    await runChat(req, env, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[chat] provider=p1"));
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `npx vitest run test/chat/runner.test.ts`
Expected: FAIL，无法解析 `../../src/chat/runner`。

- [ ] **Step 6: 实现 src/chat/runner.ts**

```ts
import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import { getChain } from "./chains";
import type { ChatRequest } from "./types";

export interface ChatOutcome {
  kind: "model-not-found" | "ok" | "all-failed";
  status: number;
  body?: unknown;
  errors?: ProviderError[];
}

export async function runChat(
  req: ChatRequest,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
): Promise<ChatOutcome> {
  const chain = getChain(req.model);
  if (!chain || chain.length === 0) {
    return { kind: "model-not-found", status: 404 };
  }

  const errors: ProviderError[] = [];
  for (const provider of chain) {
    try {
      const body = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.chat(req, env, signal);
        },
        {
          ...DEFAULT_RETRY,
          onAttempt: (info) => logAttempt("chat", provider.id, info),
          ...retryOverrides,
        },
      );
      return { kind: "ok", status: 200, body };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run test/chat/runner.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/log.ts src/chat/chains.ts src/chat/runner.ts test/chat/runner.test.ts
git commit -m "feat: add chat provider chains and runner with retry fallback"
```

---

### Task 8: read 类型与三家供应商

**Files:**
- Create: `src/read/types.ts`
- Create: `src/read/providers/jina.ts`
- Create: `src/read/providers/tavily.ts`
- Create: `src/read/providers/firecrawl.ts`
- Test: `test/read/providers.test.ts`

**Interfaces:**
- Consumes: `Env`（env.ts）、错误分类（errors.ts）
- Produces:
  - `interface ReadResult { markdown: string; title?: string }`
  - `interface ReaderProvider { id: string; read(url: string, env: Env, signal: AbortSignal): Promise<ReadResult> }`
  - `jina: ReaderProvider`（id `"jina"`，读 `env.JINA_API_KEY`）：`GET https://r.jina.ai/{url}`，header `authorization: Bearer` + `accept: text/markdown`，响应体即 Markdown。
  - `tavily: ReaderProvider`（id `"tavily"`，读 `env.TAVILY_API_KEY`）：`POST https://api.tavily.com/extract`，body `{ urls: [url] }`，Bearer 鉴权，取 `results[0].raw_content`。
  - `firecrawl: ReaderProvider`（id `"firecrawl"`，读 `env.FIRECRAWL_API_KEY`）：`POST https://api.firecrawl.dev/v2/scrape`，body `{ url, formats: ["markdown"] }`，Bearer 鉴权，取 `data.markdown`。
  - 三家共同规则：缺 key → `NonRetryableError`；fetch 抛错 → `classifyNetworkError`；非 2xx → `classifyHttpStatus`；响应非 JSON（tavily/firecrawl）→ `RetryableError`；内容为空或 trim 后为空 → `NonRetryableError`（换下家）。

- [ ] **Step 1: 创建 src/read/types.ts**

```ts
import type { Env } from "../env";

export interface ReadResult {
  markdown: string;
  title?: string;
}

export interface ReaderProvider {
  id: string;
  read(url: string, env: Env, signal: AbortSignal): Promise<ReadResult>;
}
```

- [ ] **Step 2: 实现 src/read/providers/jina.ts**

```ts
import {
  NonRetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { ReaderProvider } from "../types";

const ENV_KEY = "JINA_API_KEY";

export const jina: ReaderProvider = {
  id: "jina",
  async read(url, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    let res: Response;
    try {
      res = await fetch(`https://r.jina.ai/${url}`, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "text/markdown",
        },
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    const markdown = text.trim();
    if (markdown.length === 0) throw new NonRetryableError("jina returned empty content");
    return { markdown };
  },
};
```

- [ ] **Step 3: 实现 src/read/providers/tavily.ts**

```ts
import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { ReaderProvider } from "../types";

const ENV_KEY = "TAVILY_API_KEY";

interface TavilyExtractResponse {
  results?: { url?: string; raw_content?: string | null }[];
}

export const tavily: ReaderProvider = {
  id: "tavily",
  async read(url, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    let res: Response;
    try {
      res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ urls: [url] }),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    let json: TavilyExtractResponse;
    try {
      json = JSON.parse(text) as TavilyExtractResponse;
    } catch (err) {
      throw new RetryableError("tavily: response is not valid JSON", { cause: err });
    }

    const markdown = (json.results?.[0]?.raw_content ?? "").trim();
    if (markdown.length === 0) throw new NonRetryableError("tavily returned empty content");
    return { markdown };
  },
};
```

- [ ] **Step 4: 实现 src/read/providers/firecrawl.ts**

```ts
import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { ReaderProvider } from "../types";

const ENV_KEY = "FIRECRAWL_API_KEY";

interface FirecrawlScrapeResponse {
  data?: { markdown?: string | null };
}

export const firecrawl: ReaderProvider = {
  id: "firecrawl",
  async read(url, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    let res: Response;
    try {
      res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url, formats: ["markdown"] }),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    let json: FirecrawlScrapeResponse;
    try {
      json = JSON.parse(text) as FirecrawlScrapeResponse;
    } catch (err) {
      throw new RetryableError("firecrawl: response is not valid JSON", { cause: err });
    }

    const markdown = (json.data?.markdown ?? "").trim();
    if (markdown.length === 0) throw new NonRetryableError("firecrawl returned empty content");
    return { markdown };
  },
};
```

- [ ] **Step 5: 写测试**

Create `test/read/providers.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import { firecrawl } from "../../src/read/providers/firecrawl";
import { jina } from "../../src/read/providers/jina";
import { tavily } from "../../src/read/providers/tavily";
import type { Env } from "../../src/env";

const signal = new AbortController().signal;
const url = "https://example.com/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jina", () => {
  const env: Env = { AUTH_TOKENS: "", JINA_API_KEY: "jina-test" };

  it("GETs r.jina.ai with bearer key and returns markdown body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("# Title\n\ncontent", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await jina.read(url, env, signal);

    expect(result).toEqual({ markdown: "# Title\n\ncontent" });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://r.jina.ai/https://example.com/page");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jina-test");
  });

  it("throws NonRetryableError on empty content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("   ", { status: 200 })));
    await expect(jina.read(url, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("throws NonRetryableError when api key missing", async () => {
    await expect(jina.read(url, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps 500 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    await expect(jina.read(url, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("tavily", () => {
  const env: Env = { AUTH_TOKENS: "", TAVILY_API_KEY: "tvly-test" };

  it("posts urls array and extracts results[0].raw_content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { results: [{ url, raw_content: "# hello" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await tavily.read(url, env, signal);

    expect(result).toEqual({ markdown: "# hello" });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(String(init.body))).toEqual({ urls: [url] });
  });

  it("throws NonRetryableError when results is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { results: [], failed_results: [{ url }] })),
    );
    await expect(tavily.read(url, env, signal)).rejects.toThrow(NonRetryableError);
  });

  it("maps 429 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "limit" })));
    await expect(tavily.read(url, env, signal)).rejects.toThrow(RetryableError);
  });
});

describe("firecrawl", () => {
  const env: Env = { AUTH_TOKENS: "", FIRECRAWL_API_KEY: "fc-test" };

  it("posts v2 scrape and extracts data.markdown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, data: { markdown: "# fc" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await firecrawl.read(url, env, signal);

    expect(result).toEqual({ markdown: "# fc" });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(JSON.parse(String(init.body))).toEqual({ url, formats: ["markdown"] });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fc-test");
  });

  it("throws NonRetryableError when markdown is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { markdown: "" } })),
    );
    await expect(firecrawl.read(url, env, signal)).rejects.toThrow(NonRetryableError);
  });
});
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run test/read/providers.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 7: Commit**

```bash
git add src/read/types.ts src/read/providers/ test/read/providers.test.ts
git commit -m "feat: add read providers (jina, tavily, firecrawl)"
```

---

### Task 9: read runner

**Files:**
- Create: `src/read/runner.ts`
- Test: `test/read/runner.test.ts`

**Interfaces:**
- Consumes: `jina/tavily/firecrawl`（providers/）、`withRetry/RetryOptions`（retry.ts）、`logAttempt`（log.ts）、`DEFAULT_RETRY/UPSTREAM_TIMEOUT_MS`（config.ts）、`ProviderError`（errors.ts）、`Env`（env.ts）
- Produces:
  - `READ_CHAIN: readonly ReaderProvider[]`（顺序 jina → tavily → firecrawl，写死）
  - `interface ReadOutcome { kind: "ok" | "all-failed"; status: number; markdown?: string; errors?: ProviderError[] }`
  - `runRead(url: string, env: Env, retryOverrides?: Partial<RetryOptions>): Promise<ReadOutcome>`

- [ ] **Step 1: 写失败测试**

Create `test/read/runner.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRead } from "../../src/read/runner";
import { NonRetryableError, RetryableError } from "../../src/errors";
import type { Env } from "../../src/env";

// runner 在模块加载时构建 READ_CHAIN，因此 mock 的 provider 用「委托 state」模式：
// 对象身份固定，行为在测试里通过 state 切换。
const state = vi.hoisted(() => ({
  jinaImpl: async (_url: string): Promise<{ markdown: string }> => ({ markdown: "jina" }),
  tavilyImpl: async (_url: string): Promise<{ markdown: string }> => ({ markdown: "tavily" }),
  firecrawlImpl: async (_url: string): Promise<{ markdown: string }> => ({ markdown: "fc" }),
}));

vi.mock("../../src/read/providers/jina", () => ({
  jina: { id: "jina", read: (url: string) => state.jinaImpl(url) },
}));
vi.mock("../../src/read/providers/tavily", () => ({
  tavily: { id: "tavily", read: (url: string) => state.tavilyImpl(url) },
}));
vi.mock("../../src/read/providers/firecrawl", () => ({
  firecrawl: { id: "firecrawl", read: (url: string) => state.firecrawlImpl(url) },
}));

const env: Env = { AUTH_TOKENS: "" };
const fast = { delayMs: 0 };

describe("runRead", () => {
  beforeEach(() => {
    state.jinaImpl = async () => ({ markdown: "jina" });
    state.tavilyImpl = async () => ({ markdown: "tavily" });
    state.firecrawlImpl = async () => ({ markdown: "fc" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns jina's markdown when the first provider succeeds", async () => {
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome).toMatchObject({ kind: "ok", status: 200, markdown: "jina" });
  });

  it("follows the fixed order jina -> tavily -> firecrawl", async () => {
    const calls: string[] = [];
    state.jinaImpl = async () => {
      calls.push("jina");
      throw new NonRetryableError("empty");
    };
    state.tavilyImpl = async () => {
      calls.push("tavily");
      throw new NonRetryableError("empty");
    };
    state.firecrawlImpl = async () => {
      calls.push("firecrawl");
      return { markdown: "fc" };
    };
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome).toMatchObject({ kind: "ok", markdown: "fc" });
    expect(calls).toEqual(["jina", "tavily", "firecrawl"]);
  });

  it("retries a provider 3 times before falling back", async () => {
    let jinaCalls = 0;
    state.jinaImpl = async () => {
      jinaCalls++;
      throw new RetryableError("down");
    };
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome).toMatchObject({ kind: "ok", markdown: "tavily" });
    expect(jinaCalls).toBe(3);
  });

  it("returns 502 with aggregated errors when all providers fail", async () => {
    state.jinaImpl = async () => {
      throw new RetryableError("jina dead");
    };
    state.tavilyImpl = async () => {
      throw new NonRetryableError("tavily empty");
    };
    state.firecrawlImpl = async () => {
      throw new NonRetryableError("fc refused");
    };
    const outcome = await runRead("https://example.com", env, fast);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "jina", message: "jina dead" },
      { provider: "tavily", message: "tavily empty" },
      { provider: "firecrawl", message: "fc refused" },
    ]);
  });

  it("logs each attempt with read feature tag", async () => {
    await runRead("https://example.com", env, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[read] provider=jina"));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/read/runner.test.ts`
Expected: FAIL，无法解析 `../../src/read/runner`。

- [ ] **Step 3: 实现 src/read/runner.ts**

```ts
import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import { firecrawl } from "./providers/firecrawl";
import { jina } from "./providers/jina";
import { tavily } from "./providers/tavily";
import type { ReaderProvider } from "./types";

/** 供应商降级顺序，写死：jina → tavily → firecrawl */
export const READ_CHAIN: readonly ReaderProvider[] = [jina, tavily, firecrawl];

export interface ReadOutcome {
  kind: "ok" | "all-failed";
  status: number;
  markdown?: string;
  errors?: ProviderError[];
}

export async function runRead(
  url: string,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
): Promise<ReadOutcome> {
  const errors: ProviderError[] = [];

  for (const provider of READ_CHAIN) {
    try {
      const result = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.read(url, env, signal);
        },
        {
          ...DEFAULT_RETRY,
          onAttempt: (info) => logAttempt("read", provider.id, info),
          ...retryOverrides,
        },
      );
      return { kind: "ok", status: 200, markdown: result.markdown };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/read/runner.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add src/read/runner.ts test/read/runner.test.ts
git commit -m "feat: add read runner with fixed jina->tavily->firecrawl chain"
```

---

### Task 10: 入口路由与处理器 index.ts

**Files:**
- Create: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: `isAuthorized`（auth.ts）、`runChat/ChatOutcome`（chat/runner.ts）、`runRead/ReadOutcome`（read/runner.ts）、`Env`（env.ts）、`ChatRequest`（chat/types.ts）
- Produces: Worker 默认导出 `{ fetch(request: Request, env: Env): Promise<Response> }`。行为矩阵：
  - 非 POST 或未知路径 → 404 `{error:{message:"not found"}}`
  - 鉴权失败 → 401 `{error:{message:"unauthorized"}}`（先鉴权再解析 body）
  - chat：JSON 解析失败 → 400 `invalid_json`；缺 model → 400；messages 非数组或为空 → 400；`stream === true` → 400；model 无链 → 404 `model_not_found`；全链失败 → 502 `all_providers_failed`（附 `provider_errors`）；成功 → 200 透传 body
  - read：JSON 解析失败 → 400；url 非 http(s) 字符串 → 400；全链失败 → 502；成功 → 200 `text/markdown; charset=utf-8`

- [ ] **Step 1: 实现 src/index.ts**

```ts
import { isAuthorized } from "./auth";
import { runChat } from "./chat/runner";
import type { ChatRequest } from "./chat/types";
import type { Env } from "./env";
import { runRead } from "./read/runner";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function guard(request: Request, env: Env): Promise<Response | null> {
  if (await isAuthorized(request, env.AUTH_TOKENS)) return null;
  return json(401, { error: { message: "unauthorized" } });
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, {
      error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
    });
  }

  const req = body as Partial<ChatRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return json(400, {
      error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
    });
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return json(400, {
      error: { message: "messages must be a non-empty array", type: "invalid_request_error", code: "invalid_messages" },
    });
  }
  if (req.stream === true) {
    return json(400, {
      error: { message: "streaming is not supported", type: "invalid_request_error", code: "stream_not_supported" },
    });
  }

  const outcome = await runChat(req as ChatRequest, env);
  if (outcome.kind === "model-not-found") {
    return json(404, {
      error: {
        message: `model not found: ${req.model}`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
  }
  if (outcome.kind === "all-failed") {
    return json(502, {
      error: {
        message: "all providers failed",
        type: "upstream_error",
        code: "all_providers_failed",
        provider_errors: outcome.errors,
      },
    });
  }
  return json(200, outcome.body);
}

async function handleRead(request: Request, env: Env): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: { message: "invalid JSON body" } });
  }

  const target = (body as { url?: unknown }).url;
  if (typeof target !== "string" || !/^https?:\/\//i.test(target)) {
    return json(400, { error: { message: "url must be an http(s) URL" } });
  }

  const outcome = await runRead(target, env);
  if (outcome.kind === "all-failed") {
    return json(502, {
      error: { message: "all providers failed", provider_errors: outcome.errors },
    });
  }
  return new Response(outcome.markdown ?? "", {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      if (url.pathname === "/v1/chat/completions") return handleChat(request, env);
      if (url.pathname === "/v1/read") return handleRead(request, env);
    }
    return json(404, { error: { message: "not found" } });
  },
};
```

- [ ] **Step 2: 写测试**

Create `test/index.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOutcome } from "../src/chat/runner";
import type { ReadOutcome } from "../src/read/runner";
import type { Env } from "../src/env";

const state = vi.hoisted(() => ({
  chatOutcome: undefined as unknown as ChatOutcome,
  readOutcome: undefined as unknown as ReadOutcome,
}));

vi.mock("../src/chat/runner", () => ({
  runChat: async () => state.chatOutcome,
}));
vi.mock("../src/read/runner", () => ({
  runRead: async () => state.readOutcome,
}));

import handler from "../src/index";

const env: Env = { AUTH_TOKENS: "sekret" };

function post(path: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers.authorization = token === undefined ? "Bearer sekret" : `Bearer ${token}`;
  return new Request(`https://gw.example${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.chatOutcome = { kind: "ok", status: 200, body: { id: "default" } };
  state.readOutcome = { kind: "ok", status: 200, markdown: "# default" };
});

describe("auth", () => {
  it("rejects missing token with 401", async () => {
    const req = new Request("https://gw.example/v1/read", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects wrong token with 401 even for invalid body (auth runs first)", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "not json",
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(401);
  });
});

describe("routing", () => {
  it("returns 404 for unknown path", async () => {
    const res = await handler.fetch(post("/nope", {}), env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET on known path", async () => {
    const req = new Request("https://gw.example/v1/read", {
      headers: { authorization: "Bearer sekret" },
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(404);
  });
});

describe("chat endpoint", () => {
  it("passes through the runner body with 200", async () => {
    state.chatOutcome = { kind: "ok", status: 200, body: { id: "abc", choices: [] } };
    const res = await handler.fetch(
      post("/v1/chat/completions", { model: "sample-chat", messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ id: "abc", choices: [] });
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "not json",
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("rejects missing model with 400", async () => {
    const res = await handler.fetch(
      post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects stream=true with 400", async () => {
    const res = await handler.fetch(
      post("/v1/chat/completions", {
        model: "sample-chat",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("maps model-not-found outcome to 404", async () => {
    state.chatOutcome = { kind: "model-not-found", status: 404 };
    const res = await handler.fetch(
      post("/v1/chat/completions", { model: "nope", messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("maps all-failed outcome to 502", async () => {
    state.chatOutcome = {
      kind: "all-failed",
      status: 502,
      errors: [{ provider: "p1", message: "dead" }],
    };
    const res = await handler.fetch(
      post("/v1/chat/completions", { model: "sample-chat", messages: [{ role: "user", content: "hi" }] }),
      env,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { provider_errors: unknown[] } };
    expect(body.error.provider_errors).toEqual([{ provider: "p1", message: "dead" }]);
  });
});

describe("read endpoint", () => {
  it("returns markdown with text/markdown content type", async () => {
    state.readOutcome = { kind: "ok", status: 200, markdown: "# hi" };
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# hi");
  });

  it("rejects non-http url with 400", async () => {
    const res = await handler.fetch(post("/v1/read", { url: "ftp://example.com" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects missing url with 400", async () => {
    const res = await handler.fetch(post("/v1/read", {}), env);
    expect(res.status).toBe(400);
  });

  it("maps all-failed outcome to 502", async () => {
    state.readOutcome = {
      kind: "all-failed",
      status: 502,
      errors: [{ provider: "jina", message: "dead" }],
    };
    const res = await handler.fetch(post("/v1/read", { url: "https://example.com" }), env);
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 3: 运行确认通过**

Run: `npx vitest run test/index.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 4: 全量回归**

Run: `npm test`
Expected: 所有测试文件全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: add worker entry with auth, routing, chat and read handlers"
```

---

### Task 11: README 与验收

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 全部已完成功能
- Produces: 项目说明文档 + 验收记录（typecheck / 全量测试 / wrangler 构建冒烟均通过）

- [ ] **Step 1: 创建 README.md**

````markdown
# Providers

Cloudflare Workers 上的多供应商聚合网关：OpenAI 兼容 chat 接口 + 页面读取接口，内置重试与供应商自动降级。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI 兼容（仅非流式）。按 `model` 选择供应商链，自动重试与降级，响应原样透传。 |
| POST | `/v1/read` | body `{"url": "https://..."}`，返回页面 Markdown 正文（`text/markdown`）。供应商链固定：jina → tavily → firecrawl。 |

所有端点要求 `Authorization: Bearer <token>`。

## 重试与降级策略

- 每家供应商最多请求 3 次（重试 2 次），间隔 1 秒；单次上游超时 30 秒。
- 网络错/超时/5xx/429 触发重试；其它 4xx 不重试但直接换下一家。
- 全链失败返回 502，body 附各家错误明细。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入真实密钥
npm run dev                      # wrangler dev 本地启动
```

冒烟示例：

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer change-me-token-1" \
  -H "Content-Type: application/json" \
  -d '{"model":"sample-chat","messages":[{"role":"user","content":"hi"}]}'

curl -s http://localhost:8787/v1/read \
  -H "Authorization: Bearer change-me-token-1" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## 配置

本地密钥放 `.dev.vars`（已 gitignore）；生产用 `wrangler secret put <KEY>`：

| 变量 | 用途 |
| --- | --- |
| `AUTH_TOKENS` | 网关访问 token，逗号分隔可多个 |
| `OPENROUTER_API_KEY` | chat 示例供应商 openrouter |
| `DEEPSEEK_API_KEY` | chat 示例供应商 deepseek-official |
| `JINA_API_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` | read 三家供应商 |

## 新增一个 chat 供应商

1. 在 `src/chat/providers/` 新建文件，仿照 `openrouter.ts`：写死 `BASE_URL`、`UPSTREAM_MODEL`、`ENV_KEY`，声明 `capabilities`；`chat()` 内先 `sanitizeRequest` 裁剪、再把 `body.model` 改写为上游 model 名。
2. 在 `src/chat/chains.ts` 的 `CHAINS` 中为相应逻辑 model 插入该供应商（顺序即降级顺序）。
3. `.dev.vars.example` 与生产 secret 中补上对应 key。

## 测试与部署

```bash
npm test            # vitest 全量单测（上游全部 mock）
npm run typecheck   # tsc --noEmit
npm run deploy      # wrangler deploy（发布前建议先 wrangler deploy --dry-run）
```
````

- [ ] **Step 2: 全量验收**

Run: `npm run typecheck && npm test`
Expected: typecheck 无报错；全部测试 PASS。

Run: `npx wrangler deploy --dry-run`
Expected: 构建成功输出 bundle 信息（不实际部署、无需登录）。若本机 wrangler 版本提示 `compatibility_date` 过新，将 `wrangler.toml` 中日期改为提示的最近可用日期后重跑。

- [ ] **Step 3: Commit**

```bash
git add README.md wrangler.toml
git commit -m "docs: add README with usage, config and provider extension guide"
```

- [ ] **Step 4: 交付说明（告知用户）**

向用户汇报：功能实现完毕，单测全绿；本地联调需用户自己在 `.dev.vars` 填真实密钥后 `npm run dev` 用 curl 冒烟（真实上游调用不在自动化范围内）；正式部署由用户执行 `npm run deploy`。提醒用户 `chains.ts` 中的供应商清单为示例占位，按需替换。
