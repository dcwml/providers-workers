# send-email 端点实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** providers 网关新增 `POST /v1/send-email`（邮件发送，text/html 二选一、收件人去重、exmail→sendgrid 单次尝试+安全降级）。

**Architecture:** 新增 `src/email/` 模块，对齐既有四模块模式（types / address 纯函数 / runner 链 / providers 自包含文件）；SMTP 传输以独立协议库 `smtp-client.ts` 实现（基于 `cloudflare:sockets`，connect 依赖注入便于全 mock 测试）；邮件不幂等故不走 `DEFAULT_RETRY`，每家恰好一次尝试，`DeliveryUncertainError`（投递状态未知）中止降级防重复发信。

**Tech Stack:** Cloudflare Workers（无 Node API）、TypeScript strict、vitest（全 mock 无真实网络）、`cloudflare:sockets` TCP 出站。

**Spec:** `docs/superpowers/specs/2026-08-25-send-email-design.md`（所有行为细节以 spec 为准）

## Global Constraints

- 仅 Cloudflare Workers 运行时；禁用 Node API（无 `crypto.timingSafeEqual` 等）。
- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`；不得用 `any` 绕过。
- 每家供应商一个自包含文件（不抽公共适配器）；`smtp-client.ts` 是协议传输库（类比 fetch），不是适配层——这是 spec 3.1 节的明确豁免。
- 缺 API key → `NonRetryableError`，消息必须精确为 `${ENV_KEY} is not configured`。
- 每次上游尝试在重试闭包内新建独立 `AbortSignal.timeout(30_000)`。
- email 的重试语义特殊：`withRetry(..., { maxAttempts: 1 })`——每家恰好一次，绝不重试（邮件不幂等）。
- 测试中不得出现真实网络调用（fetch / socket 全 mock）。
- 每个任务收尾必须 `npm run typecheck && npx vitest run <本任务测试文件>` 全绿后才 commit；全部任务完成后跑 `npm run typecheck && npm test` 全量。
- 环境变量名（spec 第 8 节冻结）：`SENDGRID_API_KEY`、`EXMAIL_SMTP_PASSWORD`。
- 本机 Shell 为 Git Bash（路径 `/d/Projects/study/providers`）；所有 `npx wrangler` 命令前须 `export HTTPS_PROXY=http://127.0.0.1:7890`（api.cloudflare.com DNS 污染）；偶发 ENOTFOUND 重试即恢复。
- `.dev.vars` 为本地密钥（gitignored），严禁提交；生产变量一律 `wrangler secret put`。
- git 多会话并行：提交前 `git status` 看清，只 add 本任务明确列出的文件，绝不 `git add -A`。

---

### Task 1: SMTP spike——验证 CF 边缘可连 exmail 并完成 AUTH

**Files:**
- Create: `scripts/smtp-spike.js`
- Create: `docs/superpowers/reports/2026-08-25-smtp-spike.md`

**Interfaces:**
- Consumes: `.dev.vars` 中的 `EXMAIL_SMTP_PASSWORD`（用户已/将填写）
- Produces: spike 结论（465/SSL 是否可用、AUTH PLAIN 还是 LOGIN 成功）——Task 4 的认证顺序依据；不产出 src/ 代码

- [ ] **Step 1: 前置检查——`.dev.vars` 已填 EXMAIL_SMTP_PASSWORD**

```bash
cd /d/Projects/study/providers
grep -c '^EXMAIL_SMTP_PASSWORD=.\+' .dev.vars
```

Expected: 输出 `1`。输出 `0` 则**停下**，请用户把 SMTP 密码（若邮箱后台开了安全登录则是客户端专用密码）填入 `.dev.vars` 后再继续。

- [ ] **Step 2: 写 spike 脚本**

创建 `scripts/smtp-spike.js`（独立单文件 worker，无 wrangler.toml 依赖；只做握手+AUTH，**不 DATA、不真发邮件**）：

```js
// SMTP spike：验证 CF 边缘运行时可连腾讯企业邮箱 SMTP 并完成 AUTH（不发送邮件）。
// 部署：npx wrangler deploy scripts/smtp-spike.js --name providers-smtp-spike --compatibility-date 2026-07-01
// 密钥：grep '^EXMAIL_SMTP_PASSWORD=' .dev.vars | cut -d= -f2- | tr -d '\r' | npx wrangler secret put EXMAIL_SMTP_PASSWORD --name providers-smtp-spike
// 触发：curl "https://providers-smtp-spike.<账号子域>.workers.dev/run?mode=ssl&port=465"
// 收尾：npx wrangler delete --name providers-smtp-spike
const HOST = "smtp.exmail.qq.com";
const USER = "info@infility.cn";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    const port = Number(url.searchParams.get("port") ?? "465");
    const mode = url.searchParams.get("mode") ?? "ssl"; // ssl | starttls
    const log = [];
    const t = (s) => log.push(s);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let reader;
    let writer;

    const readReply = async () => {
      for (;;) {
        const idx = buffer.indexOf("\r\n");
        if (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          t("S: " + line);
          if (/^\d{3} /.test(line)) return line;
          if (!/^\d{3}-/.test(line)) throw new Error("malformed reply: " + line);
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done || !chunk.value) throw new Error("socket closed while reading");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    const send = async (cmd) => {
      t("C: " + cmd);
      await writer.write(encoder.encode(cmd + "\r\n"));
      return readReply();
    };
    const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

    try {
      const { connect } = await import("cloudflare:sockets");
      const socket = connect(
        { hostname: HOST, port },
        { secureTransport: mode === "ssl" ? "on" : "starttls" },
      );
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      await socket.opened;
      t("connected " + HOST + ":" + port + " mode=" + mode);
      const greeting = await readReply();
      if (!/^220 /.test(greeting)) throw new Error("bad greeting: " + greeting);
      let ehlo = await send("EHLO spike.workers.dev");
      if (mode === "starttls") {
        if (!/^250/.test(ehlo)) throw new Error("EHLO failed: " + ehlo);
        await send("STARTTLS");
        const tls = await socket.startTls({ secureTransport: "on" });
        reader = tls.readable.getReader();
        writer = tls.writable.getWriter();
        t("--- TLS upgraded ---");
        ehlo = await send("EHLO spike.workers.dev");
      }
      if (!/^250/.test(ehlo)) throw new Error("EHLO failed: " + ehlo);
      const pw = env.EXMAIL_SMTP_PASSWORD ?? "";
      let authMethod = null;
      const plain = await send("AUTH PLAIN " + b64("\u0000" + USER + "\u0000" + pw));
      if (/^235 /.test(plain)) {
        authMethod = "PLAIN";
      } else {
        const l1 = await send("AUTH LOGIN");
        if (!/^334 /.test(l1)) throw new Error("AUTH LOGIN rejected: " + l1);
        const l2 = await send(b64(USER));
        if (!/^334 /.test(l2)) throw new Error("username rejected: " + l2);
        const l3 = await send(b64(pw));
        if (!/^235 /.test(l3)) throw new Error("password rejected: " + l3);
        authMethod = "LOGIN";
      }
      t("AUTH OK via " + authMethod);
      await send("QUIT");
      socket.close().catch(() => {});
      return Response.json({ ok: true, authMethod, log });
    } catch (err) {
      return Response.json({ ok: false, error: String(err), log }, { status: 500 });
    }
  },
};
```

- [ ] **Step 3: 部署临时 worker 并配 secret**

```bash
cd /d/Projects/study/providers
export HTTPS_PROXY=http://127.0.0.1:7890
npx wrangler whoami    # 确认已登录；未登录则停下让用户 wrangler login
npx wrangler deploy scripts/smtp-spike.js --name providers-smtp-spike --compatibility-date 2026-07-01
grep '^EXMAIL_SMTP_PASSWORD=' .dev.vars | cut -d= -f2- | tr -d '\r' | npx wrangler secret put EXMAIL_SMTP_PASSWORD --name providers-smtp-spike
```

deploy 输出会打印形如 `https://providers-smtp-spike.<账号子域>.workers.dev` 的 URL，记下 `<账号子域>`。

- [ ] **Step 4: 执行 spike 并读取转录**

```bash
curl -s "https://providers-smtp-spike.<账号子域>.workers.dev/run?mode=ssl&port=465"
# 若直连超时（workers.dev 国内可能被墙）：
curl -s --proxy http://127.0.0.1:7890 "https://providers-smtp-spike.<账号子域>.workers.dev/run?mode=ssl&port=465"
```

判定（按 JSON 输出）：

- `{"ok":true,"authMethod":"PLAIN"|"LOGIN",...}` → **通过**，记录 authMethod（Task 4 依据）。
- `password rejected` / `535` → 密码类型错（客户端专用密码 vs 登录密码），**停下**请用户换正确的密码重试本步。
- 连接层失败（connect/timeout）→ 再试 `?mode=starttls&port=587`；两者都失败 → **停下**，向用户报告「CF 边缘无法连 exmail SMTP」，等待重议（spec 第 5 节：全不通则考虑砍 SMTP 或备用端口）。

- [ ] **Step 5: 删除临时 worker**

```bash
npx wrangler delete --name providers-smtp-spike
# 非交互卡住时改用： printf 'y\n' | npx wrangler delete --name providers-smtp-spike
```

- [ ] **Step 6: 写 spike 报告**

创建 `docs/superpowers/reports/2026-08-25-smtp-spike.md`，内容按实测结果填写（模板）：

```markdown
# SMTP spike：CF 边缘连接 exmail 验证（2026-08-25）

## 结论

- [通过/失败] 465/SSL：connect+TLS+EHLO+AUTH（PLAIN/LOGIN）[结果]
- [如有] 587/STARTTLS：[结果]
- 认证方式：AUTH PLAIN [成功/被拒→LOGIN 成功]（Task 4 smtp-client 认证顺序依据）
- 临时 worker providers-smtp-spike 已删除

## 转录摘录

[粘贴 curl 返回的 log 数组关键行：connected / EHLO / AUTH OK]

## 备注

- 本机 wrangler 经 HTTPS_PROXY=http://127.0.0.1:7890 执行（api.cloudflare.com DNS 污染，项目已知）
```

- [ ] **Step 7: Commit**

```bash
git add scripts/smtp-spike.js docs/superpowers/reports/2026-08-25-smtp-spike.md
git commit -m "docs: add SMTP spike script and exmail handshake verification report"
```

---

### Task 2: DeliveryUncertainError + env 声明 + telemetry feature

**Files:**
- Modify: `src/errors.ts`（NonRetryableError 类之后加新类）
- Modify: `src/env.ts:1-14`
- Modify: `src/telemetry.ts:5`（Feature 联合类型）与 `featureFromEndpoint`
- Modify: `src/log.ts:3-7`（logAttempt 的 feature 参数联合类型加 `"email"`——`Feature` 加了 email 后 telemetry.ts 自身的 `logAttempt(this.meta.feature, ...)` 调用不改这里会 typecheck 失败）
- Test: `test/errors.test.ts`、`test/telemetry.test.ts`

**Interfaces:**
- Produces: `class DeliveryUncertainError extends Error`（`name: "DeliveryUncertainError"`，构造签名 `(message: string, options?: { cause?: unknown })`）——Task 4/5/6 依赖
- Produces: `Feature` 含 `"email"`；`featureFromEndpoint("/v1/send-email") === "email"`——Task 6/7 依赖

- [ ] **Step 1: 写失败测试**

`test/errors.test.ts` 文件末尾追加：

```ts
describe("DeliveryUncertainError", () => {
  it("is a distinct Error subclass carrying its name and cause", () => {
    const cause = new TypeError("socket died");
    const err = new DeliveryUncertainError("smtp: uncertain", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DeliveryUncertainError");
    expect(err.message).toBe("smtp: uncertain");
    expect(err.cause).toBe(cause);
  });
});
```

并把文件头 import 改为：

```ts
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../src/errors";
```

`test/telemetry.test.ts` 的 `featureFromEndpoint` describe 中加一行断言：

```ts
    expect(featureFromEndpoint("/v1/send-email")).toBe("email");
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/errors.test.ts test/telemetry.test.ts
```

Expected: errors.test.ts 编译失败（`DeliveryUncertainError` 不存在）；telemetry.test.ts 断言失败（`"read"` !== `"email"`）。

- [ ] **Step 3: 实现**

`src/errors.ts` 在 `NonRetryableError` 类之后（`ProviderError` 之前）加：

```ts
/**
 * 投递状态未知（邮件不幂等）：如 SMTP DATA 阶段后超时/断连、SendGrid fetch 抛错。
 * runner 捕获后立即中止降级——防止同一封信发出两份。
 */
export class DeliveryUncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeliveryUncertainError";
  }
}
```

`src/env.ts` 在 `FIRECRAWL_API_KEY?: string;` 之后、index signature 之前加两行：

```ts
  SENDGRID_API_KEY?: string;
  EXMAIL_SMTP_PASSWORD?: string;
```

`src/telemetry.ts` 两处：

```ts
export type Feature = "chat" | "read" | "embeddings" | "rerank" | "email";
```

`featureFromEndpoint` 中（`rerank` 分支之后、`return "read"` 之前）加：

```ts
  if (endpoint.startsWith("/v1/send-email")) return "email";
```

`src/log.ts` 的 `logAttempt` 第一参数类型加 `"email"`（仅改签名，函数体不动；此联合类型与 telemetry 的 `Feature` 是既有的人工同步关系，不引入 import）：

```ts
export function logAttempt(
  feature: "chat" | "read" | "embeddings" | "rerank" | "email",
  provider: string,
  info: AttemptInfo,
): void {
```

（函数体原样保留，仅第一参数类型变化。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
npx vitest run test/errors.test.ts test/telemetry.test.ts && npm run typecheck
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/env.ts src/telemetry.ts src/log.ts test/errors.test.ts test/telemetry.test.ts
git commit -m "feat: add DeliveryUncertainError, email env keys and email telemetry feature"
```

---

### Task 3: email 类型 + 地址解析与去重（address.ts）

**Files:**
- Create: `src/email/types.ts`
- Create: `src/email/address.ts`
- Test: `test/email/address.test.ts`

**Interfaces:**
- Consumes: 无（纯函数模块）
- Produces（Task 4/5/6/7 依赖，签名逐字）:
  - `interface ParsedAddress { name?: string; address: string }`
  - `interface PreparedMail { subject: string; bodyKind: "text" | "html"; body: string; to: ParsedAddress[]; cc: ParsedAddress[]; bcc: ParsedAddress[] }`
  - `interface EmailSendResult { messageId?: string }`
  - `interface EmailProvider { id: string; from: ParsedAddress; send(mail: PreparedMail, env: Env, signal: AbortSignal): Promise<EmailSendResult> }`
  - `parseAddress(input: string): ParsedAddress | null`
  - `prepareRecipients(to: ParsedAddress[], cc: ParsedAddress[], bcc: ParsedAddress[]): { to: ParsedAddress[]; cc: ParsedAddress[]; bcc: ParsedAddress[] }`

- [ ] **Step 1: 写失败测试**

创建 `test/email/address.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseAddress, prepareRecipients } from "../../src/email/address";

describe("parseAddress", () => {
  it("parses a bare address", () => {
    expect(parseAddress("alice@example.com")).toEqual({ address: "alice@example.com" });
  });

  it("parses name and address with angle brackets", () => {
    expect(parseAddress("Alice <alice@example.com>")).toEqual({
      name: "Alice",
      address: "alice@example.com",
    });
  });

  it("parses a CJK display name", () => {
    expect(parseAddress("文明霖 <wenminglin@infility.cn>")).toEqual({
      name: "文明霖",
      address: "wenminglin@infility.cn",
    });
  });

  it("allows an empty display name", () => {
    expect(parseAddress("<alice@example.com>")).toEqual({ address: "alice@example.com" });
  });

  it("trims whitespace around the input and inner parts", () => {
    expect(parseAddress("  Alice   <  alice@example.com >  ")).toEqual({
      name: "Alice",
      address: "alice@example.com",
    });
  });

  it("rejects empty or whitespace-only input", () => {
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("   ")).toBeNull();
  });

  it("rejects a missing @ or a single-label domain", () => {
    expect(parseAddress("alice")).toBeNull();
    expect(parseAddress("alice@example")).toBeNull();
  });

  it("rejects domain labels starting or ending with a hyphen", () => {
    expect(parseAddress("a@-example.com")).toBeNull();
    expect(parseAddress("a@example-.com")).toBeNull();
  });

  it("rejects multiple bracket pairs or trailing garbage after the bracket", () => {
    expect(parseAddress("A <a@b.com> <c@d.com>")).toBeNull();
    expect(parseAddress("A <a@b.com> tail")).toBeNull();
  });

  it("rejects control characters or a closing bracket in the display name", () => {
    expect(parseAddress("Bad\u0007Name <a@b.com>")).toBeNull();
    expect(parseAddress("Bad> Name <a@b.com>")).toBeNull();
  });

  it("rejects whitespace inside the address", () => {
    expect(parseAddress("alice smith@example.com")).toBeNull();
  });
});

describe("prepareRecipients", () => {
  const A = (address: string, name?: string) =>
    name === undefined ? { address } : { name, address };

  it("dedupes within each group keeping the first occurrence with its name", () => {
    const out = prepareRecipients([A("a@x.com", "First"), A("A@X.COM")], [], []);
    expect(out.to).toEqual([{ name: "First", address: "a@x.com" }]);
  });

  it("removes cc/bcc entries that already appear in to", () => {
    const out = prepareRecipients(
      [A("a@x.com")],
      [A("a@x.com", "Dupe"), A("b@x.com")],
      [A("a@x.com"), A("b@x.com"), A("c@x.com")],
    );
    expect(out.to).toEqual([A("a@x.com")]);
    expect(out.cc).toEqual([A("b@x.com")]);
    expect(out.bcc).toEqual([A("c@x.com")]);
  });

  it("removes bcc entries that already appear in cc", () => {
    const out = prepareRecipients([A("a@x.com")], [A("b@x.com")], [A("b@x.com"), A("c@x.com")]);
    expect(out.bcc).toEqual([A("c@x.com")]);
  });

  it("compares addresses case-insensitively but keeps distinct names apart in order", () => {
    const out = prepareRecipients([A("A@X.com", "X")], [A("a@x.com", "Y")], []);
    expect(out.to).toEqual([{ name: "X", address: "A@X.com" }]);
    expect(out.cc).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/email/address.test.ts
```

Expected: FAIL（模块 `src/email/address.ts` 不存在）。

- [ ] **Step 3: 实现**

创建 `src/email/types.ts`：

```ts
import type { Env } from "../env";

export interface ParsedAddress {
  name?: string;
  address: string;
}

export interface PreparedMail {
  subject: string;
  /** html 与 text 同时提供时入口已按 html 归一 */
  bodyKind: "text" | "html";
  body: string;
  /** 已完成 to > cc > bcc 去重 */
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
}

export interface EmailSendResult {
  /** 上游返回时才有（SendGrid X-Message-Id / SMTP 自生成 Message-ID） */
  messageId?: string;
}

export interface EmailProvider {
  id: string;
  /** 内置发件人（写死在 provider 文件；请求体不接受 from） */
  from: ParsedAddress;
  send(mail: PreparedMail, env: Env, signal: AbortSignal): Promise<EmailSendResult>;
}
```

创建 `src/email/address.ts`：

```ts
import type { ParsedAddress } from "./types";

/** 实用正则子集（不追求全量 RFC 5322；带引号的极端形式不支持）。域名至少两段、段内禁连字符起止。 */
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * 解析「裸地址」或「Name <addr>」两种格式；不合法返回 null。
 * name 允许为空（`<a@b.com>`），含控制字符或 `<>` 则拒绝（防邮件头注入）。
 */
export function parseAddress(input: string): ParsedAddress | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let name: string | undefined;
  let address: string;
  const open = trimmed.indexOf("<");
  if (open === -1) {
    address = trimmed;
  } else {
    // 必须恰好以「[name] <addr>」收尾：仅一对尖括号且 > 在末尾
    if (trimmed.lastIndexOf(">") !== trimmed.length - 1) return null;
    if (trimmed.indexOf("<", open + 1) !== -1) return null;
    const inner = trimmed.slice(open + 1, trimmed.length - 1).trim();
    if (inner.length === 0 || inner.includes("<") || inner.includes(">")) return null;
    if (open > 0) {
      name = trimmed.slice(0, open).trim();
      if (/[<>\x00-\x1F\x7F]/.test(name)) return null;
      if (name.length === 0) name = undefined;
    }
    address = inner;
  }

  if (!EMAIL_RE.test(address)) return null;
  return name === undefined ? { address } : { name, address };
}

export interface PreparedRecipients {
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
}

/** to > cc > bcc 跨组去重 + 组内去重；比较键 = 地址小写；保留首次出现的写法（含其名称）。 */
export function prepareRecipients(
  to: ParsedAddress[],
  cc: ParsedAddress[],
  bcc: ParsedAddress[],
): PreparedRecipients {
  const seen = new Set<string>();
  const dedupe = (list: ParsedAddress[]): ParsedAddress[] => {
    const out: ParsedAddress[] = [];
    for (const a of list) {
      const key = a.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  };
  return { to: dedupe(to), cc: dedupe(cc), bcc: dedupe(bcc) };
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
npx vitest run test/email/address.test.ts && npm run typecheck
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/email/types.ts src/email/address.ts test/email/address.test.ts
git commit -m "feat: add email address parsing and recipient dedup"
```

---

### Task 4: SMTP 协议传输库（smtp-client.ts）

**Files:**
- Create: `src/email/smtp-client.ts`
- Test: `test/email/smtp-client.test.ts`

**Interfaces:**
- Consumes: `ParsedAddress`（Task 3）、`DeliveryUncertainError`/`NonRetryableError`/`classifyNetworkError`（Task 2）
- Produces（Task 5 依赖，签名逐字）:
  - `interface SmtpSendOptions { host: string; port: number; secure: "ssl" | "starttls"; username: string; password: string; from: ParsedAddress; to: ParsedAddress[]; cc: ParsedAddress[]; bcc: ParsedAddress[]; subject: string; bodyKind: "text" | "html"; body: string }`
  - `interface SmtpSendResult { messageId: string }`
  - `sendSmtpMail(options: SmtpSendOptions, signal: AbortSignal, connectFn?: SmtpConnectFn): Promise<SmtpSendResult>`
  - `type SmtpConnectFn = (host: string, port: number, options: { secureTransport: "on" | "starttls" }) => Promise<SmtpSocket>`
  - `interface SmtpSocket { readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array>; startTls(): Promise<SmtpSocket>; close(): Promise<void> }`
- 认证顺序依据 Task 1 spike 的 `authMethod` 结论；spike 若显示 **PLAIN 被拒而 LOGIN 成功**，把实现中 `authenticate` 的 PLAIN 分支删除（只保留 LOGIN），并把测试中 AUTH PLAIN 断言改为 AUTH LOGIN——默认按 PLAIN 优先实现。

- [ ] **Step 1: 写失败测试**

创建 `test/email/smtp-client.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  sendSmtpMail,
  type SmtpConnectFn,
  type SmtpSendOptions,
  type SmtpSocket,
} from "../../src/email/smtp-client";
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
} from "../../src/errors";

const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const enc = (s: string): string => `=?UTF-8?B?${b64(s)}?=`;

/** 脚本化 fake socket：serverSay 预灌应答（FIFO）；startTls 返回预创建的下一层 socket。 */
class FakeSocket {
  readonly written: string[] = [];
  startTlsCalls = 0;
  private nextTls: FakeSocket | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      this.controller = c;
    },
  });
  readonly writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      this.written.push(new TextDecoder().decode(chunk));
    },
  });
  async startTls(): Promise<SmtpSocket> {
    this.startTlsCalls++;
    return this.tls() as unknown as SmtpSocket;
  }
  close(): Promise<void> {
    this.controller?.close();
    return Promise.resolve();
  }
  serverSay(text: string): void {
    this.controller?.enqueue(new TextEncoder().encode(text));
  }
  serverEnd(): void {
    this.controller?.close();
  }
  tls(): FakeSocket {
    if (this.nextTls === null) this.nextTls = new FakeSocket();
    return this.nextTls;
  }
}

const signal = new AbortController().signal;

const baseOptions: SmtpSendOptions = {
  host: "smtp.test.example",
  port: 465,
  secure: "ssl",
  username: "user@test.example",
  password: "pass",
  from: { name: "Sender", address: "user@test.example" },
  to: [{ name: "甲", address: "to1@x.com" }, { address: "to2@x.com" }],
  cc: [{ address: "cc1@x.com" }],
  bcc: [{ address: "bcc1@x.com" }],
  subject: "你好 Hello",
  bodyKind: "text",
  body: "Line1\r\nLine2",
};

/** 4 个收件人（to2 + cc1 + bcc1）各回一条 250 ok */
function scriptHappyPath(socket: FakeSocket): void {
  socket.serverSay("220 smtp.test ESMTP ready\r\n");
  socket.serverSay("250-smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
  socket.serverSay("235 ok\r\n"); // AUTH PLAIN
  socket.serverSay("250 ok\r\n"); // MAIL FROM
  socket.serverSay("250 ok\r\n"); // RCPT to1
  socket.serverSay("250 ok\r\n"); // RCPT to2
  socket.serverSay("250 ok\r\n"); // RCPT cc1
  socket.serverSay("250 ok\r\n"); // RCPT bcc1
  socket.serverSay("354 end with .\r\n");
  socket.serverSay("250 queued as 123\r\n");
  socket.serverSay("221 bye\r\n"); // QUIT
}

function connectWith(socket: FakeSocket): SmtpConnectFn {
  return async () => socket as unknown as SmtpSocket;
}

describe("sendSmtpMail happy path (ssl/465)", () => {
  it("completes a full PLAIN session and writes a spec-compliant MIME message", async () => {
    const socket = new FakeSocket();
    scriptHappyPath(socket);
    const result = await sendSmtpMail(baseOptions, signal, connectWith(socket));
    expect(result.messageId).toMatch(/^<.+@test\.example>$/);

    const sent = socket.written.join("");
    expect(sent).toContain("EHLO api.oklapzlj.com\r\n");
    expect(sent).toContain(`AUTH PLAIN ${b64("\u0000user@test.example\u0000pass")}\r\n`);
    expect(sent).toContain("MAIL FROM:<user@test.example>\r\n");
    expect(sent).toContain("RCPT TO:<to1@x.com>\r\n");
    expect(sent).toContain("RCPT TO:<to2@x.com>\r\n");
    expect(sent).toContain("RCPT TO:<cc1@x.com>\r\n");
    expect(sent).toContain("RCPT TO:<bcc1@x.com>\r\n");

    const headerEnd = sent.indexOf("\r\n\r\n");
    const headers = sent.slice(0, headerEnd);
    expect(headers).toContain("From: Sender <user@test.example>");
    expect(headers).toContain(`To: ${enc("甲")} <to1@x.com>, to2@x.com`);
    expect(headers).toContain("Cc: cc1@x.com");
    expect(headers).not.toContain("Bcc:");
    expect(headers).toContain(`Subject: ${enc("你好 Hello")}`);
    expect(headers).toMatch(/Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000/);
    expect(headers).toMatch(/Message-ID: <[0-9a-f-]+@test\.example>/);
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain("Content-Type: text/plain; charset=utf-8");
    expect(headers).toContain("Content-Transfer-Encoding: base64");

    expect(sent.endsWith(".\r\nQUIT\r\n")).toBe(true);
    const m = /\r\n\r\n([\s\S]*)$/.exec(sent);
    const dataSection = m?.[1] ?? "";
    const b64Part = dataSection.slice(0, -".\r\nQUIT\r\n".length);
    const lines = b64Part.split("\r\n");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(76);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(lines.join("")), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe("Line1\r\nLine2");
  });

  it("uses text/html content type and folds long base64 bodies", async () => {
    const socket = new FakeSocket();
    scriptHappyPath(socket);
    const longBody = `Hello\r\n${"x".repeat(200)}`;
    await sendSmtpMail({ ...baseOptions, bodyKind: "html", body: longBody }, signal, connectWith(socket));
    const sent = socket.written.join("");
    expect(sent).toContain("Content-Type: text/html; charset=utf-8");
    const m = /\r\n\r\n([\s\S]*)$/.exec(sent);
    const b64Part = (m?.[1] ?? "").slice(0, -".\r\nQUIT\r\n".length);
    expect(b64Part.split("\r\n").length).toBeGreaterThanOrEqual(4);
  });

  it("succeeds even when the server drops the connection after the final 250 (QUIT failure ignored)", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverSay("250 queued\r\n");
    socket.serverEnd(); // 无 QUIT 应答，连接直接断
    const result = await sendSmtpMail(baseOptions, signal, connectWith(socket));
    expect(result.messageId).toMatch(/^</);
  });
});

describe("sendSmtpMail STARTTLS (starttls/587)", () => {
  it("upgrades to TLS before AUTH and re-issues EHLO", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("220 ready to upgrade\r\n");
    const tls = socket.tls();
    tls.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    tls.serverSay("235 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("250 ok\r\n");
    tls.serverSay("354 go\r\n");
    tls.serverSay("250 queued\r\n");
    tls.serverSay("221 bye\r\n");

    await sendSmtpMail(
      { ...baseOptions, secure: "starttls", port: 587 },
      signal,
      connectWith(socket),
    );

    expect(socket.startTlsCalls).toBe(1);
    const before = socket.written.join("");
    const after = tls.written.join("");
    expect(before).toContain("EHLO api.oklapzlj.com\r\n");
    expect(before).toContain("STARTTLS\r\n");
    expect(before).not.toContain("AUTH PLAIN"); // 凭证绝不在明文阶段发送
    expect(after).toContain("EHLO api.oklapzlj.com\r\n");
    expect(after).toContain("AUTH PLAIN ");
  });

  it("rejects when the server does not advertise STARTTLS", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    await expect(
      sendSmtpMail({ ...baseOptions, secure: "starttls", port: 587 }, signal, connectWith(socket)),
    ).rejects.toThrow(/does not advertise STARTTLS/);
  });
});

describe("sendSmtpMail AUTH", () => {
  it("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH LOGIN\r\n");
    socket.serverSay("334 VXNlcm5hbWU6\r\n");
    socket.serverSay("334 UGFzc3dvcmQ6\r\n");
    socket.serverSay("235 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverSay("250 queued\r\n");
    socket.serverSay("221 bye\r\n");

    await sendSmtpMail(baseOptions, signal, connectWith(socket));

    const sent = socket.written.join("");
    expect(sent).not.toContain("AUTH PLAIN");
    expect(sent).toContain("AUTH LOGIN\r\n");
    expect(sent).toContain(`${b64("user@test.example")}\r\n`);
    expect(sent).toContain(`${b64("pass")}\r\n`);
  });

  it("rejects with NonRetryableError on a 535 auth failure", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN LOGIN\r\n");
    socket.serverSay("535 authentication failed\r\n");
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      /AUTH PLAIN rejected: 535/,
    );
  });

  it("rejects when no supported AUTH mechanism is advertised", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 SIZE 73400320\r\n");
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      NonRetryableError,
    );
  });
});

describe("sendSmtpMail failure classification", () => {
  it("classifies connect failures as retryable network errors (safe fallback)", async () => {
    const failing: SmtpConnectFn = async () => {
      throw new TypeError("connect failed");
    };
    await expect(sendSmtpMail(baseOptions, signal, failing)).rejects.toBeInstanceOf(RetryableError);
  });

  it("classifies pre-DATA aborts as retryable network errors", async () => {
    const controller = new AbortController();
    controller.abort();
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    await expect(
      sendSmtpMail(baseOptions, controller.signal, connectWith(socket)),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it("rejects with NonRetryableError naming the refused recipient", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("550 no such user\r\n"); // to2 被拒
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      /RCPT TO <to2@x\.com> rejected: 550/,
    );
  });

  it("classifies a post-DATA disconnect as DeliveryUncertainError", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverEnd(); // 最终应答永不来
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toBeInstanceOf(
      DeliveryUncertainError,
    );
  });

  it("maps an explicit post-DATA rejection (non-250) to NonRetryableError", async () => {
    const socket = new FakeSocket();
    socket.serverSay("220 ready\r\n");
    socket.serverSay("250-x\r\n250 AUTH PLAIN\r\n");
    socket.serverSay("235 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("250 ok\r\n");
    socket.serverSay("354 go\r\n");
    socket.serverSay("550 spam detected\r\n");
    await expect(sendSmtpMail(baseOptions, signal, connectWith(socket))).rejects.toThrow(
      /rejected after DATA: 550/,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/email/smtp-client.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

创建 `src/email/smtp-client.ts`：

```ts
import { DeliveryUncertainError, NonRetryableError, classifyNetworkError } from "../errors";
import type { ParsedAddress } from "./types";

/**
 * 会话所需的 socket 最小面（cloudflare:sockets 的 Socket 结构性兼容；测试注入 FakeSocket）。
 * 这是 SMTP 协议传输库而非供应商适配层（spec 3.1 的明确豁免）。
 */
export interface SmtpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  startTls(): Promise<SmtpSocket>;
  close(): Promise<void>;
}

export type SmtpConnectFn = (
  host: string,
  port: number,
  options: { secureTransport: "on" | "starttls" },
) => Promise<SmtpSocket>;

/** 默认连接器：动态 import（cloudflare:sockets 仅 Worker 运行时存在，测试从不触达）。 */
export const defaultConnect: SmtpConnectFn = async (host, port, options) => {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname: host, port }, options);
  await socket.opened;
  return socket as unknown as SmtpSocket;
};

export interface SmtpSendOptions {
  host: string;
  port: number;
  secure: "ssl" | "starttls";
  username: string;
  password: string;
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  subject: string;
  bodyKind: "text" | "html";
  body: string;
}

export interface SmtpSendResult {
  messageId: string;
}

/** EHLO 自报域名（网关生产域名） */
const EHLO_NAME = "api.oklapzlj.com";

interface SmtpReply {
  code: number;
  text: string;
  lines: string[];
}

class SmtpSession {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  static fromSocket(socket: SmtpSocket): SmtpSession {
    return new SmtpSession(socket.readable.getReader(), socket.writable.getWriter());
  }

  async writeLine(line: string): Promise<void> {
    await this.writer.write(this.encoder.encode(line + "\r\n"));
  }

  /** 写 DATA 载荷，应用 SMTP dot-stuffing（行首 . 加倍）。 */
  async writeRaw(raw: string): Promise<void> {
    const stuffed = raw
      .split("\r\n")
      .map((l) => (l.startsWith(".") ? "." + l : l))
      .join("\r\n");
    await this.writer.write(this.encoder.encode(stuffed));
  }

  async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      const m = /^(\d{3})([- ])/.exec(line);
      if (!m) throw new Error(`smtp: malformed reply: ${line}`);
      if (m[2] === " ") break; // 最终行（250-xxx 为续行）
    }
    const first = lines[0] ?? "";
    return { code: Number(first.slice(0, 3)), text: lines.join("\n"), lines };
  }

  async sendCommand(cmd: string): Promise<SmtpReply> {
    await this.writeLine(cmd);
    return this.readReply();
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        return line;
      }
      const chunk = await this.reader.read();
      if (chunk.done || chunk.value === undefined) {
        throw new Error("smtp: connection closed unexpectedly");
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("smtp: aborted before operation");
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("smtp: aborted (timeout or cancellation)")),
        { once: true },
      );
    }),
  ]);
}

async function expectOk(reply: SmtpReply, code: number, stage: string): Promise<SmtpReply> {
  if (reply.code !== code) {
    throw new NonRetryableError(`smtp: ${stage} failed: ${reply.code} ${reply.text}`);
  }
  return reply;
}

async function authenticate(
  session: SmtpSession,
  username: string,
  password: string,
  ehloLines: string[],
  signal: AbortSignal,
): Promise<void> {
  const authLine = ehloLines.find((l) => /^\d{3}[- ]AUTH\s/i.test(l)) ?? "";
  const mechanisms = authLine.toUpperCase().split(/\s+/).slice(1);
  if (mechanisms.includes("PLAIN")) {
    const reply = await raceAbort(
      session.sendCommand(`AUTH PLAIN ${base64Utf8(`\u0000${username}\u0000${password}`)}`),
      signal,
    );
    if (reply.code !== 235) {
      throw new NonRetryableError(`smtp: AUTH PLAIN rejected: ${reply.code} ${reply.text}`);
    }
    return;
  }
  if (mechanisms.includes("LOGIN")) {
    const r1 = await raceAbort(session.sendCommand("AUTH LOGIN"), signal);
    if (r1.code !== 334) throw new NonRetryableError(`smtp: AUTH LOGIN rejected: ${r1.code} ${r1.text}`);
    const r2 = await raceAbort(session.sendCommand(base64Utf8(username)), signal);
    if (r2.code !== 334) {
      throw new NonRetryableError(`smtp: AUTH LOGIN username rejected: ${r2.code} ${r2.text}`);
    }
    const r3 = await raceAbort(session.sendCommand(base64Utf8(password)), signal);
    if (r3.code !== 235) {
      throw new NonRetryableError(`smtp: AUTH LOGIN password rejected: ${r3.code} ${r3.text}`);
    }
    return;
  }
  throw new NonRetryableError("smtp: server offers no supported AUTH mechanism (PLAIN or LOGIN)");
}

function buildMimeMessage(options: SmtpSendOptions, messageId: string): string {
  const headers: string[] = [`From: ${formatAddress(options.from)}`];
  headers.push(`To: ${options.to.map(formatAddress).join(", ")}`);
  if (options.cc.length > 0) headers.push(`Cc: ${options.cc.map(formatAddress).join(", ")}`);
  headers.push(
    `Subject: ${encodeHeaderValue(options.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: ${options.bodyKind === "html" ? "text/html" : "text/plain"}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
  );
  const folded = base64Utf8(options.body).match(/.{1,76}/g) ?? [];
  return `${headers.join("\r\n")}\r\n\r\n${folded.join("\r\n")}\r\n`;
}

function formatAddress(a: ParsedAddress): string {
  return a.name === undefined ? a.address : `${encodeHeaderValue(a.name)} <${a.address}>`;
}

/** 头部值：纯 ASCII 可打印直接用，否则整段 encoded-word（=?UTF-8?B?...?=）。 */
function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${base64Utf8(value)}?=`;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "localhost" : address.slice(at + 1);
}

/**
 * 发送一封邮件（完整 SMTP 会话）。
 * 阶段分类（spec 3.5）：DATA 354 之前的失败 = 确定未发出（网络错可降级）；
 * 354 之后收到明确非 250 应答 = 确定未发出（NonRetryableError）；
 * 354 之后超时/断连 = 投递状态未知（DeliveryUncertainError，禁止降级）。
 */
export async function sendSmtpMail(
  options: SmtpSendOptions,
  signal: AbortSignal,
  connectFn: SmtpConnectFn = defaultConnect,
): Promise<SmtpSendResult> {
  const messageId = `<${crypto.randomUUID()}@${domainOf(options.from.address)}>`;
  let socket: SmtpSocket | null = null;
  try {
    socket = await raceAbort(
      connectFn(options.host, options.port, {
        secureTransport: options.secure === "ssl" ? "on" : "starttls",
      }),
      signal,
    );
    let session = SmtpSession.fromSocket(socket);
    await expectOk(await raceAbort(session.readReply(), signal), 220, "greeting");

    let ehloLines = (
      await expectOk(await raceAbort(session.sendCommand(`EHLO ${EHLO_NAME}`), signal), 250, "EHLO")
    ).lines;

    if (options.secure === "starttls") {
      if (!ehloLines.some((l) => /^\d{3}[- ]STARTTLS/i.test(l))) {
        throw new NonRetryableError("smtp: server does not advertise STARTTLS");
      }
      await expectOk(await raceAbort(session.sendCommand("STARTTLS"), signal), 220, "STARTTLS");
      const tlsSocket = await raceAbort(socket.startTls(), signal);
      socket = tlsSocket;
      session = SmtpSession.fromSocket(tlsSocket);
      ehloLines = (
        await expectOk(
          await raceAbort(session.sendCommand(`EHLO ${EHLO_NAME}`), signal),
          250,
          "EHLO after STARTTLS",
        )
      ).lines;
    }

    await authenticate(session, options.username, options.password, ehloLines, signal);

    await expectOk(
      await raceAbort(session.sendCommand(`MAIL FROM:<${options.from.address}>`), signal),
      250,
      "MAIL FROM",
    );
    for (const r of [...options.to, ...options.cc, ...options.bcc]) {
      const reply = await raceAbort(session.sendCommand(`RCPT TO:<${r.address}>`), signal);
      if (reply.code !== 250 && reply.code !== 251) {
        throw new NonRetryableError(`smtp: RCPT TO <${r.address}> rejected: ${reply.code} ${reply.text}`);
      }
    }
    await expectOk(await raceAbort(session.sendCommand("DATA"), signal), 354, "DATA");

    // —— 354 之后：投递状态未知窗口 ——
    try {
      await raceAbort(session.writeRaw(buildMimeMessage(options, messageId)), signal);
      await raceAbort(session.writeLine("."), signal);
      const finalReply = await raceAbort(session.readReply(), signal);
      if (finalReply.code !== 250) {
        throw new NonRetryableError(
          `smtp: message rejected after DATA: ${finalReply.code} ${finalReply.text}`,
        );
      }
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new DeliveryUncertainError(`smtp: delivery uncertain after DATA: ${detail}`, {
        cause: err,
      });
    }

    try {
      // 尽力而为：QUIT 失败不影响已成功的结果
      await raceAbort(session.sendCommand("QUIT"), signal);
    } catch {
      /* ignore */
    }
    return { messageId };
  } catch (err) {
    if (err instanceof NonRetryableError || err instanceof DeliveryUncertainError) throw err;
    // 354 前的失败：确定未发出，按网络错归类（runner 可安全降级）
    throw classifyNetworkError(err);
  } finally {
    await socket?.close().catch(() => {});
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
npx vitest run test/email/smtp-client.test.ts && npm run typecheck
```

Expected: 全绿。若 typecheck 报 `cloudflare:sockets` 模块未声明（`Cannot find module 'cloudflare:sockets'`），创建 `src/types/cloudflare-sockets.d.ts`：

```ts
declare module "cloudflare:sockets" {
  export interface SocketAddress {
    hostname: string;
    port: number;
  }
  export interface SocketOptions {
    secureTransport?: "off" | "on" | "starttls";
    allowHalfOpen?: boolean;
  }
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened?: Promise<unknown>;
    startTls(options?: SocketOptions): Promise<Socket>;
    close(): Promise<void>;
  }
  export function connect(address: SocketAddress | string, options?: SocketOptions): Socket;
}
```

并把 `defaultConnect` 中 `socket.opened` 一行改为 `await (socket as unknown as { opened?: Promise<unknown> }).opened;`，重跑至全绿（d.ts 文件随本任务一并 commit）。

- [ ] **Step 5: Commit**

```bash
git add src/email/smtp-client.ts test/email/smtp-client.test.ts
# 若创建了 d.ts：git add src/types/cloudflare-sockets.d.ts
git commit -m "feat: add SMTP protocol client with staged uncertainty classification"
```

---

### Task 5: 供应商文件（sendgrid + exmail）

**Files:**
- Create: `src/email/providers/sendgrid.ts`
- Create: `src/email/providers/exmail.ts`
- Test: `test/email/providers.test.ts`

**Interfaces:**
- Consumes: `EmailProvider`/`PreparedMail`/`ParsedAddress`（Task 3）、`sendSmtpMail`（Task 4）、`classifyHttpStatus`/错误类（Task 2）
- Produces（Task 6 依赖）: `export const sendgrid: EmailProvider`（id=`"sendgrid"`）、`export const exmail: EmailProvider`（id=`"exmail"`）

- [ ] **Step 1: 写失败测试**

创建 `test/email/providers.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
} from "../../src/errors";
import { sendgrid } from "../../src/email/providers/sendgrid";
import { exmail } from "../../src/email/providers/exmail";
import type { PreparedMail } from "../../src/email/types";
import type { Env } from "../../src/env";

const mail: PreparedMail = {
  subject: "Hi",
  bodyKind: "html",
  body: "<p>Hello</p>",
  to: [{ name: "A", address: "a@x.com" }, { address: "b@x.com" }],
  cc: [{ address: "c@x.com" }],
  bcc: [{ address: "d@x.com" }],
};
const signal = new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sendgrid email provider", () => {
  const env: Env = { SENDGRID_API_KEY: "sg-test" };

  it("sends the mapped payload and returns the X-Message-Id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 202, headers: { "x-message-id": "abc123" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendgrid.send(mail, env, signal);

    expect(result).toEqual({ messageId: "abc123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sg-test");
    expect(JSON.parse(String(init.body))).toEqual({
      personalizations: [
        {
          to: [{ email: "a@x.com", name: "A" }, { email: "b@x.com" }],
          cc: [{ email: "c@x.com" }],
          bcc: [{ email: "d@x.com" }],
        },
      ],
      from: { email: "info@infility.cn", name: "Infility" },
      subject: "Hi",
      content: [{ type: "text/html", value: "<p>Hello</p>" }],
    });
  });

  it("omits cc/bcc keys when empty and omits message_id when header absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendgrid.send({ ...mail, cc: [], bcc: [] }, env, signal);

    expect(result).toEqual({});
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { personalizations: unknown[] };
    expect(sent.personalizations).toEqual([
      { to: [{ email: "a@x.com", name: "A" }, { email: "b@x.com" }] },
    ]);
  });

  it("maps text bodyKind to text/plain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendgrid.send({ ...mail, bodyKind: "text", body: "plain" }, env, signal);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { content: { type: string }[] };
    expect(sent.content).toEqual([{ type: "text/plain", value: "plain" }]);
  });

  it("throws NonRetryableError with the standard message when key missing", async () => {
    await expect(sendgrid.send(mail, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(
      "SENDGRID_API_KEY is not configured",
    );
  });

  it("maps a fetch rejection to DeliveryUncertainError (request may have been accepted)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(sendgrid.send(mail, env, signal)).rejects.toBeInstanceOf(DeliveryUncertainError);
  });

  it("maps 4xx to NonRetryableError and 5xx to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    await expect(sendgrid.send(mail, env, signal)).rejects.toBeInstanceOf(NonRetryableError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    await expect(sendgrid.send(mail, env, signal)).rejects.toBeInstanceOf(RetryableError);
  });
});

// exmail 经 vi.mock 隔离 smtp-client（测试不触达真实 socket）
const sendSmtpMailMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/email/smtp-client", () => ({
  sendSmtpMail: sendSmtpMailMock,
}));

describe("exmail email provider", () => {
  it("throws NonRetryableError with the standard message when password missing", async () => {
    await expect(exmail.send(mail, { AUTH_TOKENS: "" }, signal)).rejects.toThrow(
      "EXMAIL_SMTP_PASSWORD is not configured",
    );
  });

  it("delegates to sendSmtpMail with the baked-in transport config", async () => {
    sendSmtpMailMock.mockResolvedValue({ messageId: "<m@infility.cn>" });

    const result = await exmail.send(mail, { EXMAIL_SMTP_PASSWORD: "pw" }, signal);

    expect(result).toEqual({ messageId: "<m@infility.cn>" });
    expect(sendSmtpMailMock).toHaveBeenCalledTimes(1);
    const [options, sig, connectFn] = sendSmtpMailMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
      AbortSignal,
      undefined,
    ];
    expect(options).toMatchObject({
      host: "smtp.exmail.qq.com",
      port: 465,
      secure: "ssl",
      username: "info@infility.cn",
      password: "pw",
      from: { name: "Infility", address: "info@infility.cn" },
      subject: "Hi",
      bodyKind: "html",
      body: "<p>Hello</p>",
    });
    expect(options.to).toBe(mail.to);
    expect(options.cc).toBe(mail.cc);
    expect(options.bcc).toBe(mail.bcc);
    expect(sig).toBe(signal);
    expect(connectFn).toBeUndefined();
  });

  it("propagates errors from the smtp client", async () => {
    sendSmtpMailMock.mockRejectedValue(new NonRetryableError("smtp: AUTH PLAIN rejected: 535 x"));
    await expect(
      exmail.send(mail, { EXMAIL_SMTP_PASSWORD: "pw" }, signal),
    ).rejects.toThrow(NonRetryableError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/email/providers.test.ts
```

Expected: FAIL（provider 模块不存在）。

- [ ] **Step 3: 实现**

创建 `src/email/providers/sendgrid.ts`：

```ts
import {
  DeliveryUncertainError,
  NonRetryableError,
  classifyHttpStatus,
} from "../../errors";
import type { Env } from "../../env";
import type { EmailProvider, PreparedMail } from "../types";

const BASE_URL = "https://api.sendgrid.com/v3";
const ENV_KEY = "SENDGRID_API_KEY";
const FROM = { name: "Infility", address: "info@infility.cn" } as const;

function toApiAddress(a: { name?: string; address: string }): { email: string; name?: string } {
  return a.name === undefined ? { email: a.address } : { email: a.address, name: a.name };
}

export const sendgrid: EmailProvider = {
  id: "sendgrid",
  from: FROM,
  async send(mail: PreparedMail, env: Env, signal: AbortSignal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    const body = {
      personalizations: [
        {
          to: mail.to.map(toApiAddress),
          ...(mail.cc.length > 0 ? { cc: mail.cc.map(toApiAddress) } : {}),
          ...(mail.bcc.length > 0 ? { bcc: mail.bcc.map(toApiAddress) } : {}),
        },
      ],
      from: toApiAddress(FROM),
      subject: mail.subject,
      content: [
        { type: mail.bodyKind === "html" ? "text/html" : "text/plain", value: mail.body },
      ],
    };

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/mail/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // 超时/网络中断：请求可能已被上游受理，投递状态未知——禁止降级（spec 3.6）
      const detail = err instanceof Error ? err.message : String(err);
      throw new DeliveryUncertainError(
        `sendgrid: request failed, delivery may be uncertain: ${detail}`,
        { cause: err },
      );
    }

    if (!res.ok) throw classifyHttpStatus(res.status, await res.text());
    // 202 响应体为空；messageId 取 X-Message-Id 头，缺失则无
    const messageId = res.headers.get("x-message-id") ?? undefined;
    return messageId === undefined ? {} : { messageId };
  },
};
```

创建 `src/email/providers/exmail.ts`：

```ts
import { NonRetryableError } from "../../errors";
import type { Env } from "../../env";
import { sendSmtpMail } from "../smtp-client";
import type { EmailProvider, PreparedMail, ParsedAddress } from "../types";

const HOST = "smtp.exmail.qq.com";
const PORT = 465;
const SECURE = "ssl" as const;
const USERNAME = "info@infility.cn";
const FROM: ParsedAddress = { name: "Infility", address: "info@infility.cn" };
const ENV_KEY = "EXMAIL_SMTP_PASSWORD";

export const exmail: EmailProvider = {
  id: "exmail",
  from: FROM,
  async send(mail: PreparedMail, env: Env, signal: AbortSignal) {
    const password = env[ENV_KEY];
    if (!password) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    return sendSmtpMail(
      {
        host: HOST,
        port: PORT,
        secure: SECURE,
        username: USERNAME,
        password,
        from: FROM,
        to: mail.to,
        cc: mail.cc,
        bcc: mail.bcc,
        subject: mail.subject,
        bodyKind: mail.bodyKind,
        body: mail.body,
      },
      signal,
    );
  },
};
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
npx vitest run test/email/providers.test.ts && npm run typecheck
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/email/providers/sendgrid.ts src/email/providers/exmail.ts test/email/providers.test.ts
git commit -m "feat: add sendgrid and exmail email providers"
```

---

### Task 6: email runner（单次尝试 + 安全降级）

**Files:**
- Create: `src/email/runner.ts`
- Test: `test/email/runner.test.ts`

**Interfaces:**
- Consumes: `EmailProvider`/`PreparedMail`（Task 3）、`DeliveryUncertainError`（Task 2）、`withRetry`/`logAttempt`/`RequestRecorder`（既有）
- Produces（Task 7 依赖）:
  - `EMAIL_CHAIN: readonly EmailProvider[]`（`[exmail, sendgrid]`）
  - `EMAIL_PROVIDER_IDS: readonly string[]`（`["exmail", "sendgrid"]`）
  - `getEmailProviderById(id: string): EmailProvider | undefined`
  - `runEmail(mail: PreparedMail, env: Env, only?: EmailProvider, recorder?: RequestRecorder): Promise<EmailOutcome>`
  - `interface EmailOutcome { kind: "ok" | "uncertain" | "all-failed"; status: number; body?: unknown; errors?: ProviderError[]; providerOk?: string }`

- [ ] **Step 1: 写失败测试**

创建 `test/email/runner.test.ts`（委托 state 模式，同 `test/read/runner.test.ts`）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailProviderById, runEmail } from "../../src/email/runner";
import {
  DeliveryUncertainError,
  NonRetryableError,
  RetryableError,
} from "../../src/errors";
import type { Env } from "../../src/env";
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { makeFakeCtx, makeFakeD1 } from "../helpers";
import { exmail } from "../../src/email/providers/exmail";
import type { PreparedMail } from "../../src/email/types";

// runner 在模块加载时构建 EMAIL_CHAIN，因此 mock 的 provider 用「委托 state」模式。
const state = vi.hoisted(() => ({
  exmailImpl: async (): Promise<{ messageId: string }> => ({ messageId: "m1" }),
  sendgridImpl: async (): Promise<{ messageId: string }> => ({ messageId: "m2" }),
}));

vi.mock("../../src/email/providers/exmail", () => ({
  exmail: {
    id: "exmail",
    from: { address: "info@infility.cn" },
    send: (...a: unknown[]) =>
      (state.exmailImpl as (...args: unknown[]) => unknown)(...a),
  },
}));
vi.mock("../../src/email/providers/sendgrid", () => ({
  sendgrid: {
    id: "sendgrid",
    from: { address: "info@infility.cn" },
    send: (...a: unknown[]) =>
      (state.sendgridImpl as (...args: unknown[]) => unknown)(...a),
  },
}));

const env: Env = { AUTH_TOKENS: "" };
const mail: PreparedMail = {
  subject: "Hi",
  bodyKind: "text",
  body: "hello",
  to: [{ address: "a@x.com" }],
  cc: [],
  bcc: [],
};

describe("runEmail", () => {
  beforeEach(() => {
    state.exmailImpl = async () => ({ messageId: "m1" });
    state.sendgridImpl = async () => ({ messageId: "m2" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok with provider body when the first provider succeeds", async () => {
    const outcome = await runEmail(mail, env);
    expect(outcome).toEqual({
      kind: "ok",
      status: 200,
      body: { accepted: true, provider: "exmail", message_id: "m1" },
      providerOk: "exmail",
    });
  });

  it("omits message_id when the provider returns none", async () => {
    state.exmailImpl = async () => ({});
    const outcome = await runEmail(mail, env);
    expect(outcome.body).toEqual({ accepted: true, provider: "exmail" });
  });

  it("falls back to sendgrid after a safe (determined) failure", async () => {
    const calls: string[] = [];
    state.exmailImpl = async () => {
      calls.push("exmail");
      throw new NonRetryableError("EXMAIL_SMTP_PASSWORD is not configured");
    };
    state.sendgridImpl = async () => {
      calls.push("sendgrid");
      return { messageId: "m2" };
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("sendgrid");
    expect(calls).toEqual(["exmail", "sendgrid"]);
  });

  it("does NOT retry a provider even on retryable errors (single attempt)", async () => {
    let exmailCalls = 0;
    state.exmailImpl = async () => {
      exmailCalls++;
      throw new RetryableError("network error: down");
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("sendgrid");
    expect(exmailCalls).toBe(1);
  });

  it("aborts the chain on DeliveryUncertainError (next provider must not run)", async () => {
    const calls: string[] = [];
    state.exmailImpl = async () => {
      calls.push("exmail");
      throw new DeliveryUncertainError("smtp: delivery uncertain after DATA: timeout");
    };
    state.sendgridImpl = async () => {
      calls.push("sendgrid");
      return { messageId: "m2" };
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "exmail", message: "smtp: delivery uncertain after DATA: timeout" },
    ]);
    expect(calls).toEqual(["exmail"]);
  });

  it("returns all-failed with aggregated errors when every provider fails safely", async () => {
    state.exmailImpl = async () => {
      throw new NonRetryableError("exmail dead");
    };
    state.sendgridImpl = async () => {
      throw new RetryableError("sendgrid down");
    };
    const outcome = await runEmail(mail, env);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.status).toBe(502);
    expect(outcome.errors).toEqual([
      { provider: "exmail", message: "exmail dead" },
      { provider: "sendgrid", message: "sendgrid down" },
    ]);
  });

  it("runs only the specified provider when only is passed (no fallback)", async () => {
    const calls: string[] = [];
    state.exmailImpl = async () => {
      calls.push("exmail");
      throw new NonRetryableError("exmail dead");
    };
    state.sendgridImpl = async () => {
      calls.push("sendgrid");
      return { messageId: "m2" };
    };
    const outcome = await runEmail(mail, env, exmail);
    expect(outcome.kind).toBe("all-failed");
    expect(outcome.errors).toEqual([{ provider: "exmail", message: "exmail dead" }]);
    expect(calls).toEqual(["exmail"]);
  });

  it("resolves providers by id through the real registry", () => {
    expect(getEmailProviderById("exmail")?.id).toBe("exmail");
    expect(getEmailProviderById("sendgrid")?.id).toBe("sendgrid");
    expect(getEmailProviderById("bogus")).toBeUndefined();
  });

  it("logs each attempt with email feature tag", async () => {
    await runEmail(mail, env);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[email] provider=exmail"));
  });

  it("records attempts via recorder and reports providerOk on success", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const recorder = new RequestRecorder(c.ctx, d1.db, {
      requestId: "r9",
      feature: "email",
      endpoint: "/v1/send-email",
      model: "",
      tokenId: 1,
    });
    const outcome = await runEmail(mail, env, undefined, recorder);
    expect(outcome.kind).toBe("ok");
    expect(outcome.providerOk).toBe("exmail");
    await Promise.all(c.promises);
    const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.params).toEqual(["r9", "email", "exmail", "", 1, "ok", expect.any(Number), null]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/email/runner.test.ts
```

Expected: FAIL（`src/email/runner.ts` 不存在）。

- [ ] **Step 3: 实现**

创建 `src/email/runner.ts`：

```ts
import { UPSTREAM_TIMEOUT_MS } from "../config";
import { DeliveryUncertainError, type ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry } from "../retry";
import type { RequestRecorder } from "../telemetry";
import { exmail } from "./providers/exmail";
import { sendgrid } from "./providers/sendgrid";
import type { EmailProvider, PreparedMail } from "./types";

/** 供应商降级顺序，写死：exmail → sendgrid（自有邮箱信誉优先，SendGrid 兜底）。 */
export const EMAIL_CHAIN: readonly EmailProvider[] = [exmail, sendgrid];

export const EMAIL_PROVIDER_IDS: readonly string[] = EMAIL_CHAIN.map((p) => p.id);

export function getEmailProviderById(id: string): EmailProvider | undefined {
  return EMAIL_CHAIN.find((p) => p.id === id);
}

export interface EmailOutcome {
  kind: "ok" | "uncertain" | "all-failed";
  status: number;
  body?: unknown;
  errors?: ProviderError[];
  /** 成功时由哪家供应商提供（kind=ok 才有），供监控记录 */
  providerOk?: string;
}

/**
 * 单次尝试 + 安全降级（与 chat/read 的 DEFAULT_RETRY 不同——邮件不幂等）：
 * 每家恰好发一次（maxAttempts:1，仅复用 withRetry 的遥测接线）；
 * 「确定没发出」的失败换下家；DeliveryUncertainError（投递状态未知）立即中止，不降级。
 */
export async function runEmail(
  mail: PreparedMail,
  env: Env,
  only?: EmailProvider,
  recorder?: RequestRecorder,
): Promise<EmailOutcome> {
  // ?provider= 覆盖：隔离只跑指定单家，不降级；缺省走固定链。
  const chain: readonly EmailProvider[] = only ? [only] : EMAIL_CHAIN;
  const errors: ProviderError[] = [];

  for (const provider of chain) {
    try {
      const result = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          return provider.send(mail, env, signal);
        },
        {
          maxAttempts: 1,
          onAttempt: (info) =>
            recorder ? recorder.attempt(provider.id, info) : logAttempt("email", provider.id, info),
        },
      );
      return {
        kind: "ok",
        status: 200,
        body: {
          accepted: true,
          provider: provider.id,
          ...(result.messageId === undefined ? {} : { message_id: result.messageId }),
        },
        providerOk: provider.id,
      };
    } catch (err) {
      errors.push({
        provider: provider.id,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof DeliveryUncertainError) {
        return { kind: "uncertain", status: 502, errors };
      }
    }
  }

  return { kind: "all-failed", status: 502, errors };
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
npx vitest run test/email/runner.test.ts && npm run typecheck
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/email/runner.ts test/email/runner.test.ts
git commit -m "feat: add email runner with single-attempt safe fallback"
```

---

### Task 7: 入口路由与 handleEmail

**Files:**
- Modify: `src/index.ts`（imports + handleEmail + parseRecipientField/recipientsError 辅助 + fetch 路由分支）
- Test: `test/index.test.ts`（新增 mock + describe）

**Interfaces:**
- Consumes: `runEmail`/`getEmailProviderById`/`EMAIL_PROVIDER_IDS`（Task 6）、`parseAddress`/`prepareRecipients`（Task 3）、`withRecording`/`json`（既有）
- Produces: `POST /v1/send-email` 端点（Task 8 文档、Task 9 冒烟依赖）

- [ ] **Step 1: 写失败测试**

`test/index.test.ts` 修改三处：

（a）文件头 import 增加类型：

```ts
import type { EmailOutcome } from "../src/email/runner";
```

（b）`state` 的 `vi.hoisted` 对象里增加两个属性：

```ts
  emailOutcome: undefined as unknown as EmailOutcome,
  emailOnly: undefined as unknown,
  emailMail: undefined as unknown,
```

（c）在 `vi.mock("../src/rerank/runner", ...)` 之后新增一个 mock（放在 `import handler from "../src/index";` 之前）：

```ts
vi.mock("../src/email/runner", () => ({
  runEmail: async (mail: unknown, _env: unknown, only: unknown) => {
    state.emailMail = mail;
    state.emailOnly = only;
    return state.emailOutcome;
  },
  getEmailProviderById: (id: string) =>
    id === "exmail" || id === "sendgrid" ? { id } : undefined,
  EMAIL_PROVIDER_IDS: ["exmail", "sendgrid"],
}));
```

（d）`beforeEach` 里增加默认值：

```ts
  state.emailOutcome = { kind: "ok", status: 200, body: { accepted: true, provider: "exmail" }, providerOk: "exmail" };
  state.emailOnly = undefined;
  state.emailMail = undefined;
```

（e）在 `describe("provider override (?provider=)")` 之前插入新 describe：

```ts
describe("send-email endpoint", () => {
  const validBody = {
    subject: "Hello",
    html: "<p>Hi</p>",
    to: ["a@x.com"],
  };

  it("passes through the runner body with 200", async () => {
    state.emailOutcome = {
      kind: "ok",
      status: 200,
      body: { accepted: true, provider: "exmail", message_id: "m1" },
      providerOk: "exmail",
    };
    const res = await handler.fetch(post("/v1/send-email", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, provider: "exmail", message_id: "m1" });
  });

  it("prefers html when both text and html are provided", async () => {
    await handler.fetch(
      post("/v1/send-email", { ...validBody, text: "plain fallback" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(state.emailMail).toMatchObject({ bodyKind: "html", body: "<p>Hi</p>" });
  });

  it("uses text when html is absent", async () => {
    await handler.fetch(
      post("/v1/send-email", { subject: "s", text: "plain only" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(state.emailMail).toMatchObject({ bodyKind: "text", body: "plain only" });
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("https://gw.example/v1/send-email", {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: "not json",
    });
    const res = await handler.fetch(req, env, makeFakeCtx().ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a null body and missing subject with 400", async () => {
    const res1 = await handler.fetch(post("/v1/send-email", null), env, makeFakeCtx().ctx);
    expect(res1.status).toBe(400);
    const res2 = await handler.fetch(
      post("/v1/send-email", { html: "x", to: ["a@x.com"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("missing_subject");
  });

  it("rejects control characters in subject with invalid_subject", async () => {
    const res = await handler.fetch(
      post("/v1/send-email", { ...validBody, subject: "bad\u0007subject" }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_subject");
  });

  it("rejects missing body with missing_body", async () => {
    const res = await handler.fetch(
      post("/v1/send-email", { subject: "s", to: ["a@x.com"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_body");
  });

  it("rejects invalid to types with invalid_recipients", async () => {
    const res1 = await handler.fetch(
      post("/v1/send-email", { ...validBody, to: [] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res1.status).toBe(400);
    const res2 = await handler.fetch(
      post("/v1/send-email", { ...validBody, to: 42 }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("invalid_recipients");
  });

  it("rejects a malformed address with a positioned message", async () => {
    const res = await handler.fetch(
      post("/v1/send-email", { ...validBody, cc: ["ok@x.com", "not-an-address"] }),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_recipients");
    expect(body.error.message).toContain('cc[1]: invalid address "not-an-address"');
  });

  it("accepts a single string recipient and dedupes across groups", async () => {
    await handler.fetch(
      post("/v1/send-email", {
        subject: "s",
        html: "x",
        to: "A@X.com",
        cc: ["a@x.com", "c@x.com"],
        bcc: ["c@x.com"],
      }),
      env,
      makeFakeCtx().ctx,
    );
    expect(state.emailMail).toMatchObject({
      to: [{ address: "A@X.com" }],
      cc: [{ address: "c@x.com" }],
      bcc: [],
    });
  });

  it("maps uncertain outcome to 502 delivery_uncertain", async () => {
    state.emailOutcome = {
      kind: "uncertain",
      status: 502,
      errors: [{ provider: "exmail", message: "uncertain" }],
    };
    const res = await handler.fetch(post("/v1/send-email", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; provider_errors: unknown[] } };
    expect(body.error.code).toBe("delivery_uncertain");
    expect(body.error.provider_errors).toEqual([{ provider: "exmail", message: "uncertain" }]);
  });

  it("maps all-failed outcome to 502 all_providers_failed", async () => {
    state.emailOutcome = {
      kind: "all-failed",
      status: 502,
      errors: [{ provider: "exmail", message: "dead" }],
    };
    const res = await handler.fetch(post("/v1/send-email", validBody), env, makeFakeCtx().ctx);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_providers_failed");
  });

  it("resolves ?provider=sendgrid and rejects unknown providers", async () => {
    const res = await handler.fetch(
      post("/v1/send-email?provider=sendgrid", validBody),
      env,
      makeFakeCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect((state.emailOnly as { id: string }).id).toBe("sendgrid");

    const res2 = await handler.fetch(
      post("/v1/send-email?provider=bogus", validBody),
      env,
      makeFakeCtx().ctx,
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: { code: string; message: string } };
    expect(body2.error.code).toBe("unknown_provider");
    expect(body2.error.message).toContain("exmail, sendgrid");
  });

  it("records one requests row with feature email", async () => {
    const d1 = makeFakeD1();
    d1.setRows(TOKEN_LOOKUP_SQL, [{ id: 3 }]);
    const c = makeFakeCtx();
    const envReq: WorkerEnv = { DB: d1.db } as WorkerEnv;
    const res = await handler.fetch(post("/v1/send-email", validBody), envReq, c.ctx);
    expect(res.status).toBe(200);
    await Promise.all(c.promises);
    const row = d1.statements.find((s) => s.sql === INSERT_REQUEST_SQL);
    expect(row?.params[1]).toBe("email");
    expect(row?.params[3]).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/index.test.ts
```

Expected: 新 describe 全 FAIL（404——路由不存在），原有测试仍绿。

- [ ] **Step 3: 实现 `src/index.ts`**

（a）import 区（`rerank` import 之后、`telemetry` import 之前）增加：

```ts
import { parseAddress, prepareRecipients } from "./email/address";
import { EMAIL_PROVIDER_IDS, getEmailProviderById, runEmail } from "./email/runner";
import type { EmailProvider, ParsedAddress, PreparedMail } from "./email/types";
```

（b）在 `handleRerank` 函数之后新增三个函数：

```ts
type RecipientParse =
  | { ok: true; list: ParsedAddress[] }
  | { ok: false; message: string };

function parseRecipientField(field: string, value: unknown): RecipientParse {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (values === null || values.length === 0) {
    return { ok: false, message: `${field} must be a non-empty string or a non-empty array of addresses` };
  }
  const list: ParsedAddress[] = [];
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    if (typeof item !== "string") {
      return { ok: false, message: `${field}[${i}] must be a string` };
    }
    const parsed = parseAddress(item);
    if (parsed === null) {
      return { ok: false, message: `${field}[${i}]: invalid address "${item}"` };
    }
    list.push(parsed);
  }
  return { ok: true, list };
}

function recipientsError(message: string): HandlerResult {
  return {
    response: json(400, {
      error: { message, type: "invalid_request_error", code: "invalid_recipients" },
    }),
  };
}

async function handleEmail(
  request: Request,
  env: WorkerEnv,
  providerParam: string | null,
  recorder: RequestRecorder,
  meta: RecorderMeta,
): Promise<HandlerResult> {
  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: EmailProvider | undefined;
  if (providerParam !== null) {
    only = getEmailProviderById(providerParam);
    if (!only) {
      return {
        response: json(400, {
          error: {
            message: `unknown provider: ${providerParam}; valid providers: ${EMAIL_PROVIDER_IDS.join(", ")}`,
            type: "invalid_request_error",
            code: "unknown_provider",
          },
        }),
      };
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: json(400, {
        error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
      }),
    };
  }
  const req = (body ?? {}) as { [key: string]: unknown };

  if (typeof req.subject !== "string" || req.subject.length === 0) {
    return {
      response: json(400, {
        error: { message: "subject is required", type: "invalid_request_error", code: "missing_subject" },
      }),
    };
  }
  if (/[\x00-\x1F\x7F]/.test(req.subject)) {
    return {
      response: json(400, {
        error: {
          message: "subject must not contain control characters",
          type: "invalid_request_error",
          code: "invalid_subject",
        },
      }),
    };
  }

  // text/html 二选一：都传以 html 为准（不报错）；至少一个非空
  const html = typeof req.html === "string" && req.html.length > 0 ? req.html : null;
  const text = typeof req.text === "string" && req.text.length > 0 ? req.text : null;
  if (html === null && text === null) {
    return {
      response: json(400, {
        error: {
          message: "text or html body is required",
          type: "invalid_request_error",
          code: "missing_body",
        },
      }),
    };
  }

  const toParsed = parseRecipientField("to", req.to);
  if (!toParsed.ok) return recipientsError(toParsed.message);
  let cc: ParsedAddress[] = [];
  if (req.cc !== undefined) {
    const parsed = parseRecipientField("cc", req.cc);
    if (!parsed.ok) return recipientsError(parsed.message);
    cc = parsed.list;
  }
  let bcc: ParsedAddress[] = [];
  if (req.bcc !== undefined) {
    const parsed = parseRecipientField("bcc", req.bcc);
    if (!parsed.ok) return recipientsError(parsed.message);
    bcc = parsed.list;
  }

  const recipients = prepareRecipients(toParsed.list, cc, bcc);
  const mail: PreparedMail = {
    subject: req.subject,
    bodyKind: html !== null ? "html" : "text",
    body: html ?? text ?? "",
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
  };

  const outcome = await runEmail(mail, env, only, recorder);
  if (outcome.kind === "all-failed") {
    return {
      response: json(502, {
        error: {
          message: "all email providers failed",
          type: "upstream_error",
          code: "all_providers_failed",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  if (outcome.kind === "uncertain") {
    return {
      response: json(502, {
        error: {
          message:
            "delivery is uncertain: the upstream may have accepted the message; provider fallback was suppressed to avoid duplicate sends",
          type: "upstream_error",
          code: "delivery_uncertain",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  return { response: json(200, outcome.body), providerOk: outcome.providerOk };
}
```

（c）fetch 路由——在 `/v1/rerank` 分支之后、闭括号之前加：

```ts
      if (url.pathname === "/v1/send-email") {
        return withRecording(request, env, ctx, url.pathname, "email", (recorder, meta) =>
          handleEmail(request, env, providerParam, recorder, meta),
        );
      }
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
npx vitest run test/index.test.ts && npm run typecheck
```

Expected: 全绿（含原有全部测试）。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: add POST /v1/send-email endpoint with validation and dedup"
```

---

### Task 8: 文档全套

**Files:**
- Create: `docs/API-email.md`
- Modify: `docs/API.md`、`README.md`、`docs/monitoring-sql.md`、`AGENTS.md`

**Interfaces:**
- Consumes: Task 1-7 的最终行为（错误码表与 Task 7 实现逐字一致）
- Produces: 无代码接口

- [ ] **Step 1: 创建 `docs/API-email.md`**

```markdown
# /v1/send-email 邮件发送接口使用说明

发送一封纯文本或 HTML 邮件（无附件）。供应商链固定 **exmail（腾讯企业邮箱 SMTP）→ sendgrid**，串行降级；因邮件不幂等，降级语义与其它接口不同（见「降级语义」）。

- 生产域名：`https://api.oklapzlj.com`
- 路径：`POST /v1/send-email`（仅支持 POST）
- 请求体：`application/json`；错误体 OpenAI 风格 `{ "error": { "message", "type", "code", "provider_errors?" } }`

## 认证

所有请求必须携带 Bearer token（与其它业务接口一致）：

```
Authorization: Bearer <token>
```

token 由管理员经 /admin 后台创建与停用。缺失或错误返回 `401 {"error":{"message":"unauthorized"}}`。

## 请求格式

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `subject` | string | 是 | 邮件主题；不允许包含控制字符 |
| `text` | string | 与 `html` 二选一 | 纯文本正文 |
| `html` | string | 与 `text` 二选一 | HTML 正文。**`text` 与 `html` 同时提供时不报错，以 `html` 为准** |
| `to` | string \| string[] | 是 | 收件人；单个字符串等价于单元素数组（不按逗号拆分） |
| `cc` | string \| string[] | 否 | 抄送；格式同 `to`，缺省为空 |
| `bcc` | string \| string[] | 否 | 密送；格式同 `to`，缺省为空。密送地址只进投递指令，不出现在邮件头 |

收件人每一项支持两种格式：

- 裸地址：`alice@example.com`
- 名称 + 地址：`Alice <alice@example.com>`（名称允许中文与空格，可为空）

任一项格式不合法返回 400，message 指明位置，如 `cc[2]: invalid address "xxx"`。

**去重规则**：按地址部分忽略大小写比较；`to` > `cc` > `bcc`——出现在 `to` 的地址自动从 `cc`/`bcc` 移除，出现在 `cc` 的自动从 `bcc` 移除；同组内重复只保留首次出现（保留其名称写法）。

发件人由网关内置（当前 exmail 与 sendgrid 均为 `Infility <info@infility.cn>`），请求体**不接受** `from` 字段。不支持附件（attachment）。

```json
{
  "subject": "周报提醒",
  "html": "<p>请于周五前提交周报。</p>",
  "to": ["张三 <zhangsan@example.com>", "lisi@example.com"],
  "cc": "wangwu@example.com"
}
```

## 响应格式

成功（200）：

```json
{ "accepted": true, "provider": "exmail", "message_id": "<uuid@infility.cn>" }
```

`message_id` 仅上游返回时携带（SMTP 恒有；SendGrid 有 `X-Message-Id` 响应头时才有）。

## 错误码速查

| 状态码 | code | 原因 |
| --- | --- | --- |
| 401 | — | token 缺失或错误（`unauthorized`） |
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 400 | `missing_subject` | `subject` 缺失或为空 |
| 400 | `invalid_subject` | `subject` 含控制字符 |
| 400 | `missing_body` | `text` 与 `html` 均缺失或为空 |
| 400 | `invalid_recipients` | `to`/`cc`/`bcc` 类型不对，或某项地址格式非法（message 指明位置） |
| 400 | `unknown_provider` | `?provider=` 传了未知值（message 列出合法 id） |
| 502 | `all_providers_failed` | 全链失败且每家都确定未发出；看 `provider_errors` |
| 502 | `delivery_uncertain` | **投递状态未知**（上游可能已受理）——为避免重复发送已中止降级。调用方应先排查（收件箱/监控）再决定是否重发 |

## 降级语义（与其它接口不同，重要）

- **每家供应商只发一次，不重试**（单次上游超时 30 秒）——邮件不幂等，重试可能把同一封信发出两份。
- 「确定没发出去」的失败（缺 key、连接失败、认证被拒、收件人被拒、上游明确报错）自动换下一家。
- 「不确定发没发出去」的失败（SMTP DATA 阶段后超时/断连、SendGrid 请求超时）**立即中止并返回 `delivery_uncertain`，不降级**。
- 链顺序固定：exmail → sendgrid；缺 key 的家自动跳过。

## 供应商隔离参数（调试用）

URL 追加 `?provider=<id>` 强制只跑指定的一家，**不做降级**：

```
POST /v1/send-email?provider=exmail
POST /v1/send-email?provider=sendgrid
```

未知取值直接 400。正常业务调用不要带此参数。

## 调用示例

```bash
export GATEWAY_TOKEN="<向管理员索取>"

curl -X POST "https://api.oklapzlj.com/v1/send-email" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subject":"周报提醒","html":"<p>请于周五前提交周报。</p>","to":["张三 <zhangsan@example.com>"]}'

# 隔离测试单家（不降级）
curl -X POST "https://api.oklapzlj.com/v1/send-email?provider=exmail" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subject":"test","text":"plain body","to":["lisi@example.com"]}'
```

## 生产现状

[由 Task 9 完成时按实测结果填写：exmail/sendgrid 各自可用性、发件认证状态]
```

- [ ] **Step 2: `docs/API.md` 三处更新**

接口一览表 `rerank` 行之后加一行：

```markdown
| POST | `/v1/send-email` | 发送邮件（`text`/`html` 二选一，`to`/`cc`/`bcc` 跨组去重，无附件）。供应商链固定：exmail → sendgrid；单次尝试 + 安全降级。 | [API-email.md](./API-email.md) |
```

错误体风格一节改为：

```markdown
- chat / embeddings / rerank / email：OpenAI 风格 `{ "error": { "message", "type", "code", "provider_errors?" } }`
```

重试策略总览一段末尾追加一句：

```markdown
email 例外：每家恰好一次、绝不重试；「确定没发出」才降级，「不确定」（投递状态未知）中止并返回 502 `delivery_uncertain`（详见 API-email.md）。
```

- [ ] **Step 3: `README.md` 四处更新**

（a）开头简介句改为：

```markdown
Cloudflare Workers 上的多供应商聚合网关：OpenAI 兼容 chat 接口 + embeddings 接口 + rerank 接口 + 页面读取接口 + 邮件发送接口，内置重试与供应商自动降级。
```

（b）端点表 `rerank` 行之后加：

```markdown
| POST | `/v1/send-email` | 发送纯文本/HTML 邮件（无附件，`to`/`cc`/`bcc` 跨组去重）。供应商链固定：exmail → sendgrid；每家单次尝试 + 安全降级（投递状态未知时中止防重复发信）。 |
```

（c）「重试与降级策略」小节末尾追加：

```markdown
- email 例外：邮件不幂等——每家只发一次不重试；「确定没发出」的失败才降级，「不确定发没发出」（如 DATA 阶段后超时）中止并返回 502 `delivery_uncertain`。
```

（d）配置表 `TAVILY_API_KEY` 行之后加：

```markdown
| `SENDGRID_API_KEY` | email 供应商 sendgrid（HTTP API 发信） |
| `EXMAIL_SMTP_PASSWORD` | email 供应商 exmail（腾讯企业邮箱 SMTP 密码；后台开了安全登录时填客户端专用密码） |
```

（e）冒烟示例 curl 列表末尾追加：

```bash
curl -s http://localhost:8787/v1/send-email \
  -H "Authorization: Bearer sk_local_localtest1234" \
  -H "Content-Type: application/json" \
  -d '{"subject":"smoke test","text":"hello from local dev","to":["a@example.com"]}'
```

- [ ] **Step 4: `docs/monitoring-sql.md` 两处更新**

（a）「表速览」`requests` 行中 `feature(chat/read/embeddings/rerank)` 改为 `feature(chat/read/embeddings/rerank/email)`。

（b）查询集末尾（第 10 条之后、「容量提示」之前）追加：

````markdown
**11. 邮件发送量（近 30 天，按供应商）**

```sql
SELECT provider,
       COUNT(*) AS attempts,
       SUM(result = 'ok') AS ok
FROM provider_attempts
WHERE feature = 'email'
  AND datetime(created_at) >= datetime('now', '-30 days')
GROUP BY provider;
```
````

- [ ] **Step 5: `AGENTS.md` 两处更新**

（a）目录结构 `read/` 行之后加一行：

```markdown
  email/          # types / address（地址解析+去重）/ runner（链）/ smtp-client（SMTP 协议库）/ providers/（exmail、sendgrid）
```

（b）「供应商链」小节 `rerank` 条目之后追加：

```markdown
- email：`src/email/runner.ts` 的 `EMAIL_CHAIN` 固定 exmail → sendgrid。**单次尝试 + 安全降级**：每家恰好一次（`withRetry` 传 `maxAttempts:1`，仅取遥测接线），「确定没发出」的失败换下家；`DeliveryUncertainError`（投递状态未知：SMTP DATA 354 后超时/断连、SendGrid fetch 抛错）立即中止不降级，返回 502 `delivery_uncertain`——邮件不幂等，防重复发信，勿「统一」成 DEFAULT_RETRY。收件人解析与 to>cc>bcc 去重在 `src/email/address.ts`；from 内置于各 provider 文件；`smtp-client.ts` 是协议传输库（依赖注入 connect 便于 mock），不算供应商适配层。
```

- [ ] **Step 6: Commit**

```bash
git add docs/API-email.md docs/API.md README.md docs/monitoring-sql.md AGENTS.md
git commit -m "docs: document send-email endpoint and email module conventions"
```

---

### Task 9: 本地真实发信冒烟 + 完成报告 + 全量验收

**Files:**
- Create: `docs/superpowers/reports/2026-08-25-send-email-completion.md`
- Modify: `docs/API-email.md`（「生产现状」小节填实测）

**Interfaces:**
- Consumes: 全部前序任务；`.dev.vars`（`EXMAIL_SMTP_PASSWORD`、`SENDGRID_API_KEY`、`ADMIN_TOKEN`）
- Produces: 完成报告（含真实发信证据）

- [ ] **Step 1: 全量静态验收**

```bash
cd /d/Projects/study/providers
npm run typecheck && npm test
```

Expected: 全绿（0 失败）。

- [ ] **Step 2: 本地起服 + 建 token + 真发一封（exmail）**

```bash
npx wrangler d1 migrations apply providers_db --local   # 本地库 schema（已初始化则幂等跳过）
npm run dev                                              # 后台跑，默认 http://localhost:8787
```

另开一个命令（ADMIN_TOKEN 从 `.dev.vars` 读，不要回显到聊天）：

```bash
ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '\r')
curl -s http://localhost:8787/admin/api/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prefix":"sk_local_","random":"emailsmoke1","label":"email-smoke"}'
# 若返回 409（token 已存在）则复用 sk_local_emailsmoke1
curl -s http://localhost:8787/v1/send-email?provider=exmail \
  -H "Authorization: Bearer sk_local_emailsmoke1" \
  -H "Content-Type: application/json" \
  -d '{"subject":"send-email 冒烟测试（本地）","html":"<p>本地冒烟 <b>HTML</b> 正文。</p>","to":["wenminglin@infility.cn"]}'
```

Expected: `{"accepted":true,"provider":"exmail","message_id":"<...@infility.cn>"}`。请用户查收 wenminglin@infility.cn 收件箱（或让用户指定其它收件邮箱替换地址重发）。

- [ ] **Step 3: sendgrid 隔离冒烟（本地网络受限属预期）**

```bash
curl -s http://localhost:8787/v1/send-email?provider=sendgrid \
  -H "Authorization: Bearer sk_local_emailsmoke1" \
  -H "Content-Type: application/json" \
  -d '{"subject":"send-email sendgrid 冒烟（本地）","text":"plain body","to":["wenminglin@infility.cn"]}'
```

Expected: 若返回 200 即通过。若返回 502 `delivery_uncertain`/网络错误——**属预期**（本机 workerd 出网不走代理，api.sendgrid.com 国内不可达，先例见 2026-08-17 read 冒烟报告），记录实测输出到完成报告，生产验证留待部署后（spec 范围外）。若返回 403——SendGrid 发件认证未配置，记录并提醒用户在 SendGrid 后台认证发件地址（spec 3.6 节前提）。

- [ ] **Step 4: 停掉 dev server，写完成报告**

创建 `docs/superpowers/reports/2026-08-25-send-email-completion.md`：

```markdown
# send-email 端点完成报告（2026-08-25）

## 交付内容

- `POST /v1/send-email`：subject/text/html/to/cc/bbcc 校验、html 优先、地址两种格式解析、to>cc>bcc 去重
- `src/email/`：types / address / smtp-client（协议库，connect 注入）/ runner（单次尝试+安全降级）/ providers（exmail、sendgrid）
- `DeliveryUncertainError` 中止降级语义；telemetry feature=email
- 文档：API-email.md 新建；API.md / README / monitoring-sql.md / AGENTS.md 同步

## 验收证据

- `npm run typecheck`：[粘贴输出摘要]
- `npm test`：[粘贴 N 个测试全绿摘要]
- SMTP spike（详见 2026-08-25-smtp-spike.md）：[通过方式与 authMethod]
- 本地真实发信（exmail）：[粘贴 200 响应 JSON]；收件确认：[用户口头确认/待确认]
- sendgrid 本地隔离冒烟：[实测结果与判定]

## 范围外（待用户另行安排）

- 生产部署：`wrangler secret put SENDGRID_API_KEY` + `wrangler secret put EXMAIL_SMTP_PASSWORD`（值同 .dev.vars）→ git push 自动部署 → 生产 `?provider=` 双家各真发一封验证
- SendGrid 发件认证（如 Step 3 报 403）
```

`docs/API-email.md` 的「生产现状」小节按 Step 2/3 实测结果替换占位段（例：本地 exmail 已验证可用；sendgrid 本地网络不可达待生产验证）。

- [ ] **Step 5: 全量复验 + Commit**

```bash
npm run typecheck && npm test
git add docs/superpowers/reports/2026-08-25-send-email-completion.md docs/API-email.md
git commit -m "docs: add send-email completion report with local smoke evidence"
```

---

## 计划外事项（执行者须知）

1. **spike 失败分支**：Task 1 Step 4 的连接层失败且 587 也不通 → 停止整个计划，向用户报告（spec 第 5 节：重议 HTTP-only 或备用端口）。不要自行砍掉 SMTP provider 继续。
2. **spike 显示 PLAIN 被拒**：按 Task 4 Interfaces 的说明调整 `authenticate`（删 PLAIN 分支）并同步测试断言，在完成报告中记录原因。
3. **生产部署不在本计划内**（spec 范围外）：完成报告列明待办即可，**不要执行 git push**。
4. 本机 wrangler/DNS 抖动（ENOTFOUND/ConnectEx）：重试一次再判断失败。
