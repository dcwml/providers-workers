# Providers 网关设计规格

> 状态：已确认（brainstorming 产出）
> 日期：2026-08-14
> 运行环境：**仅 Cloudflare Workers**（Node.js 不在范围内）

## 一、目标与范围

一个部署在 Cloudflare Workers 上的多供应商聚合网关，对外提供两个功能：

1. **`POST /v1/chat/completions`** —— OpenAI 兼容的聊天接口（仅非流式），背后挂多个上游供应商，按逻辑 model 选择并自动降级。
2. **`POST /v1/read`** —— 读取页面并返回 Markdown 正文，背后挂 jina / tavily / firecrawl 三家，固定顺序降级。
3. **搜索** —— 本期不实现。

核心诉求：任一供应商失败时自动重试、并在供应商之间降级，直到成功或全部失败。

## 二、已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 运行环境 | 仅 Cloudflare Workers，忽略 Node.js |
| 技术栈 | TypeScript + 原生 `fetch` handler + wrangler + vitest |
| 网关鉴权 | 需要，`Authorization: Bearer <token>`，token 存环境变量，可多个 |
| chat 路由 | 代码中按不同 `model` 写死供应商调用顺序（不同 model 不同顺序） |
| 能力属性用途 | 每个供应商自行裁剪请求：不支持的参数直接删除后再提交上游 |
| 不支持 system prompt | 把 system 内容合并进第一条 user 消息 |
| chat 响应 | 上游 JSON **原样透传**，`model` 字段也不改写 |
| 适配器组织 | 每家供应商独立实现文件；重试/降级引擎抽为通用组件 |
| 失败判定 | 网络错/超时/5xx/429 → 可重试；其它 4xx → 不重试但仍换下一家 |
| 重试策略 | 每家最多请求 3 次（重试 2 次），间隔 1 秒 |
| 上游超时 | 单次上游请求 30 秒（常量可调） |
| read 接口形态 | POST，body `{url}`，返回提取后的 Markdown 正文 |
| read 供应商顺序 | 写死固定顺序：jina → tavily → firecrawl |
| 首批供应商清单 | 占位待定，实现时填入 |

## 三、总体流程

```
请求 → index.ts fetch 入口
     → Bearer Token 鉴权（失败 401）
     → 路由分发：
         POST /v1/chat/completions → chat runner
         POST /v1/read             → read runner
         其它路径/方法             → 404
```

两个功能共用同一个 **runner** 模式：

1. 拿到一条**供应商链**（chat 按 model 查表得到；read 用固定链）。
2. 按顺序逐个调用供应商，每家最多请求 3 次（重试 2 次、间隔 1 秒）。
3. 任一家成功即返回。
4. 全链失败 → 返回 502，附各家最后的错误信息。

重试引擎 `retry.ts` 为两功能共用的通用组件。

## 四、目录结构

```
providers/
├── wrangler.toml / .dev.vars（本地密钥，gitignore）
├── package.json / tsconfig.json / vitest.config.ts
├── src/
│   ├── index.ts        # 入口：鉴权 + 路由
│   ├── auth.ts         # Bearer Token 校验
│   ├── retry.ts        # 通用重试引擎
│   ├── errors.ts       # RetryableError / NonRetryableError / 错误响应
│   ├── chat/
│   │   ├── types.ts    # OpenAI 请求/响应类型、Capability 定义
│   │   ├── chains.ts   # 逻辑 model → 供应商有序数组（写死）
│   │   ├── runner.ts   # 链条执行
│   │   ├── sanitize.ts # 共享裁剪工具（避免每家重复写）
│   │   └── providers/  # 每家供应商一个文件
│   └── read/
│       ├── runner.ts
│       └── providers/  # jina.ts / tavily.ts / firecrawl.ts
└── test/               # vitest 单元测试
```

## 五、chat 接口设计

### 请求契约

- 完全 OpenAI 兼容，仅非流式。
- `stream: true` 直接返回 400 拒绝。
- 未知 `model` 返回 404「model not found」。

### ChatProvider 接口

每个供应商文件导出一个 `ChatProvider`：

```ts
interface ChatProvider {
  id: string;
  capabilities: {
    systemPrompt: boolean;
    tools: boolean;
    json_object: boolean;
    json_schema: boolean;
  };
  chat(req: ChatRequest, env: Env, signal: AbortSignal): Promise<ChatResponse>;
}
```

文件内**写死**自己的 base url 和上游 model 名，api key 从 `env` 读取。

Provider 职责：调用 `sanitize.ts` 按能力裁剪请求 → fetch 上游 → 非 2xx 抛分类错误 → 解析响应。

### 请求裁剪规则

由 `sanitize.ts` 统一实现，各 provider 调用：

- 不支持 `tools` → 删除 `tools` 和 `tool_choice`。
- 不支持 `json_object` → 删除 `response_format`。
- 不支持 `json_schema` → 若支持 `json_object` 则降级为 `json_object`，否则删除 `response_format`。
- 不支持 system prompt → 把所有 system 消息的内容按原顺序拼接，合并进第一条 user 消息（置于其内容之前，换行分隔）；若消息列表中不存在 user 消息，则将合并后的内容作为新的第一条 user 消息插入。合并后从列表中移除原 system 消息。

### 失败分类与降级

- 网络错 / 超时 / 5xx / 429 → 可重试：重试至 3 次后换下一家。
- 其它 4xx → 不重试，但**仍换下一家**（不同供应商审核/密钥情况不同，值得试）。
- 全链失败 → 返回 502，附各家最后的错误信息。

### 响应

- 上游 JSON **原样透传**，`model` 字段不改写，`usage` 透传。

### 超时

- 单次上游请求 `AbortSignal.timeout(30_000)`，30 秒为常量可调。

## 六、read 接口设计

### 请求契约

- `POST /v1/read`，body `{ "url": "https://..." }`。
- 校验 url 必须是 http/https，否则 400。

### 响应

- 成功：200，`Content-Type: text/markdown; charset=utf-8`，body 直接是 Markdown 正文。
- 失败：JSON 错误 `{ "error": { "message" } }`。

### 供应商链

写死固定顺序：**jina → tavily → firecrawl**。三家 API 形态不同、各自实现，归一化为 `{ markdown, title? }`：

| 供应商 | 调用方式 | 取值字段 |
| --- | --- | --- |
| jina | `GET https://r.jina.ai/{url}`，Bearer key | 响应即 Markdown 文本 |
| tavily | `POST https://api.tavily.com/extract` | `raw_content` |
| firecrawl | `POST https://api.firecrawl.dev/v1/scrape`，`formats:["markdown"]` | `data.markdown` |

### 失败判定

- 与 chat 一致：网络错/超时/5xx/429 可重试（3 次、间隔 1 秒）；其它 4xx 不重试直接换下家。
- **返回空内容也视为失败**，换下一家。
- 全链失败返回 502。

## 七、共享机制

- **鉴权**：`env.AUTH_TOKENS`（逗号分隔，支持多个 token），用 `crypto.timingSafeEqual` 比较防时序攻击，不合法返回 401。
- **密钥管理**：本地开发用 `.dev.vars`（已在 .gitignore），生产用 `wrangler secret put`。需要的 key：
  - `AUTH_TOKENS`
  - 各 chat 供应商的 key（每个 provider 文件声明自己读哪个变量名）
  - `JINA_API_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY`
- **重试引擎**：`withRetry(fn, { maxAttempts: 3, delayMs: 1000 })`，只捕获 `RetryableError` 重试，重试间隔用 setTimeout Promise 等待；`NonRetryableError` 立即抛出交给 runner 换下家。
- **超时**：单次上游请求 `AbortSignal.timeout(30_000)`，常量可调。
- **日志**：每次上游尝试打一条结构化日志：`[chat|read] provider=xxx attempt=1/3 result=ok|retry|fatal elapsed=123ms`，生产用 `wrangler tail` 查看。
- **错误响应格式**：chat 用 OpenAI 风格 `{ "error": { "message", "type", "code" } }`；read 用简化版 `{ "error": { "message" } }`。

## 八、测试与验收

### 单元测试（vitest）

核心逻辑全部有测试覆盖，上游 HTTP 用 mock，不依赖真实网络与 key：

- `retry.test.ts`：重试次数恰好 3 次、间隔 1 秒、可重试错误触发重试、`NonRetryableError` 立即抛出、重试耗尽后抛出最后错误。
- `sanitize.test.ts`：四条裁剪规则逐一覆盖（删 tools/tool_choice、删 response_format、json_schema 降级 json_object、system 合并进首条 user 消息，且覆盖无 user 消息时的兜底行为）。
- `chat/runner.test.ts`：用假 provider 验证链条顺序、第一家失败自动换第二家、全链失败返回 502 聚合错误、未知 model 返回 404。
- `read/runner.test.ts`：同上，外加空内容视为失败换下家。
- `auth.test.ts`：token 合法/非法/缺失三条路径。

### 本地联调（手动）

`wrangler dev` + `.dev.vars` 填真实 key，用 curl 冒烟：

- chat 正常返回。
- 故意配错第一家 key，验证自动降级到下一家。
- `/v1/read` 返回 Markdown。
- 401 / 404 / 400 路径正确。

### 验收标准

实现完成的标志：

1. 上述单测全部通过（全绿）。
2. 本地 `wrangler dev` 冒烟通过。
3. 代码可通过 `wrangler deploy` 部署（部署动作本身由用户执行）。

## 九、开放项（实现时确定）

- **首批 chat 供应商清单**：具体逻辑 model 名、每个 model 的供应商顺序、各家 base url 与上游 model 名，实现时填入 `chains.ts` 与 `providers/`。
- **read 上游 API 细节核对**：tavily `extract` 与 firecrawl `scrape` 的具体请求/响应字段，实现时以官方最新文档为准。
