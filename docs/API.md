# 接口目录

多供应商聚合网关的全部 HTTP 接口索引。网关部署于 Cloudflare Workers，所有接口均为 `POST` + JSON 请求体，且都要求 Bearer 鉴权。

- 生产域名：`https://api.oklapzlj.com`
- 本地联调：`npm run dev` 后为 `http://localhost:8787`

## 接口一览

| 方法 | 路径 | 说明 | 详细文档 |
| --- | --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI 兼容 chat（仅非流式）。按 `model` 选择供应商链，自动重试与降级，响应原样透传。 | [API-chat.md](./API-chat.md) |
| POST | `/v1/embeddings` | OpenAI 兼容 embeddings。按 `model` 映射到单个 provider，无链、无降级。当前：`BAAI/bge-m3` → siliconflow。 | [API-embeddings.md](./API-embeddings.md) |
| POST | `/v1/rerank` | 文档重排序。按 `model` 映射到单个 provider，无链、无降级。当前：`BAAI/bge-reranker-v2-m3` → siliconflow。 | [API-rerank.md](./API-rerank.md) |
| POST | `/v1/send-email` | 发送邮件（`text`/`html` 二选一，`to`/`cc`/`bcc` 跨组去重，无附件）。供应商链固定：exmail → sendgrid；单次尝试 + 安全降级。 | [API-email.md](./API-email.md) |
| POST | `/v1/read` | 给一个 URL，返回网页正文 Markdown。供应商链固定：jina → tavily → firecrawl。 | [API-read.md](./API-read.md) |
| POST | `/v1/search` | 网页搜索（`query` 必填，可选 `max_results` 1-10）。返回上游 JSON 信封，原样透传。供应商链固定：anysearch。 | [API-search.md](./API-search.md) |
| GET | `/admin` | 管理后台页面（token 管理）。数据接口 `/admin/api/*` 需 `ADMIN_TOKEN`，非业务端点。 | — |

## 通用约定

**鉴权**：业务接口（`/v1/*`）必须携带 `Authorization: Bearer <token>`，token 由管理员经 /admin 后台创建与停用（存 D1，管理密钥为 ADMIN_TOKEN secret）。缺失或错误返回 `401 {"error":{"message":"unauthorized"}}`。`/admin` 页面本身免鉴权；`/admin/api/*` 用 `ADMIN_TOKEN`（非业务端点，见上表）。

**供应商隔离参数**：所有接口支持 URL 追加 `?provider=<id>` 强制只跑指定的一家（不做降级），用于排查单家供应商问题；未知取值返回 400 并列出合法 id。正常业务调用不要带此参数。

**通用状态码**：

| 状态码 | 含义 |
| --- | --- |
| 401 | token 缺失或错误 |
| 400 | 请求体不合法（JSON 解析失败、必填字段缺失、未知 model/provider 等） |
| 404 | 方法不是 POST，或路径不存在 |
| 502 | 上游供应商失败，body 中 `provider_errors` 给出每家失败原因 |

**错误体风格**（勿混用）：

- chat / embeddings / rerank / email：OpenAI 风格 `{ "error": { "message", "type", "code", "provider_errors?" } }`
- read / search：简化形 `{ "error": { "message", "provider_errors?" } }`

**重试策略总览**：单家供应商最多 3 次尝试（首次 + 2 次重试，间隔 1 秒），单次上游超时 30 秒；网络错/超时/5xx/429 触发重试，其它 4xx 不重试。chat/read 在供应商之间串行降级；embeddings/rerank 为单 provider 形式，失败即 502。email 例外：每家恰好一次、绝不重试；「确定没发出」才降级，「不确定」（投递状态未知）中止并返回 502 `delivery_uncertain`（详见 API-email.md）。

## 相关文档

- `README.md`：端点速览、本地开发、密钥配置表、部署命令
- `AGENTS.md`：项目工作手册（代码层约定，面向开发者）
- `docs/superpowers/reports/`：各次实现/探测的过程记录
- `docs/monitoring-sql.md`：监控数据（requests / provider_attempts）常用 SQL 统计查询
