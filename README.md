# Providers

Cloudflare Workers 上的多供应商聚合网关：OpenAI 兼容 chat 接口 + embeddings 接口 + rerank 接口 + 页面读取接口 + 搜索接口 + 邮件发送接口 + 天气查询接口，内置重试与供应商自动降级。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI 兼容（仅非流式）。按 `model` 选择供应商链，自动重试与降级，响应原样透传。 |
| POST | `/v1/read` | body `{"url": "https://..."}`，返回页面 Markdown 正文（`text/markdown`）。供应商链固定：jina → tavily → firecrawl。 |
| POST | `/v1/search` | body `{"query": "..."}`，可选 `max_results`（1-10）。返回上游搜索结果 JSON（原样透传）。供应商链固定：anysearch → firecrawl（anysearch 支持匿名访问，配 key 提升限额）。 |
| POST | `/v1/embeddings` | OpenAI 兼容 embeddings。按 `model` 映射到单个 provider（无链、无降级），响应原样透传。当前：`BAAI/bge-m3` → siliconflow；`jina-embeddings-v5-omni-small` → jina（多模态，`task`/`normalized` 透传）。 |
| POST | `/v1/rerank` | 文档重排序（Jina/Cohere 风格：`query` + `documents`，可选 `top_n`/`return_documents`）。按 `model` 映射到单个 provider（无链、无降级），响应原样透传。当前：`BAAI/bge-reranker-v2-m3` → siliconflow。 |
| POST | `/v1/send-email` | 发送纯文本/HTML 邮件（无附件，`to`/`cc`/`bcc` 跨组去重）。供应商链固定：exmail → sendgrid；每家单次尝试 + 安全降级（投递状态未知时中止防重复发信）。 |
| POST | `/v1/weather` | 天气查询（实况 + 1-16 天日预报）。位置输入四选一：地名（`"广州"`）/ 地图分享链接（百度、高德，自动换算坐标系）/ `latitude`+`longitude` 直传 / 缺省按调用方 IP 定位。响应 `{location, weather}` 信封。供应商：open-meteo（免 key，地理编码与预报均走它）。 |
| GET | `/admin` | 管理后台（token 管理：新建/启停/删除/改接口权限，自动生成随机串）。数据接口 `/admin/api/*` 需 `ADMIN_TOKEN`。 |
| GET | `/README.md` | 项目说明文档（即本文件的 Markdown 原文，免鉴权）。 |

业务端点要求 `Authorization: Bearer <token>`；token 由管理员在 `/admin` 后台创建与停用（存 D1，无需重新部署）。

### Token 接口权限（scopes）

每个 token 可限制能调用的业务接口：`chat` / `read` / `search` / `embeddings` / `rerank` / `email` / `weather`（与端点一一对应）。**scopes 为空 = 不限制**（可调用全部接口），存量 token 默认行为不变。token 无某接口权限时调用返回 403 `insufficient_scope`（同样记录监控）。

- 后台：新建时勾选权限；列表「改权限」可随时调整（逗号分隔，留空 = 不限制）。
- API：创建/编辑时传 `scopes` 数组，如 `{"prefix":"sk_","random":"...","scopes":["chat","search"]}`；`[]` 等同不限制；未知接口名返回 400 `invalid_scopes`。
- `GET /admin/api/tokens` 返回 `scopes` 数组，空数组 = 不限制。

## 重试与降级策略

- 每家供应商最多请求 3 次（重试 2 次），间隔 1 秒；单次上游超时 30 秒。
- 网络错/超时/5xx/429 触发重试；其它 4xx 不重试但直接换下一家。
- 全链失败返回 502，body 附各家错误明细。
- embeddings/rerank 例外：单 provider 形式，无链、无降级，失败即返回 502（单家内部重试策略同上）。
- weather 同为单 provider（open-meteo，免 key）：地理编码与预报两阶段各自独立重试；地名查不到返回 404（不重试不降级）。
- email 例外：邮件不幂等——每家只发一次不重试；「确定没发出」的失败才降级，「不确定发没发出」（如 DATA 阶段后超时）中止并返回 502 `delivery_uncertain`。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入真实密钥（ADMIN_TOKEN 必填，供应商 key 可选）
npx wrangler d1 migrations apply providers_db --local   # 初始化本地 D1（tokens/requests/provider_attempts）
npm run dev                      # wrangler dev 本地启动
```

冒烟前先创建一个网关调用 token：用 `.dev.vars` 里的 `ADMIN_TOKEN` 调本地管理 API（完整 token 仅创建时返回一次；也可在 `http://localhost:8787/admin` 页面操作）：

```bash
curl -s http://localhost:8787/admin/api/tokens \
  -H "Authorization: Bearer <你的 ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"prefix":"sk_local_","random":"localtest1234","label":"smoke"}'
# → {"id":1,"token":"sk_local_localtest1234","token_mask":"sk_local_loca...1234"}
```

冒烟示例（以下 `Authorization` 用上一步返回的 token）：

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sk_local_localtest1234" \
  -H "Content-Type: application/json" \
  -d '{"model":"sample-chat","messages":[{"role":"user","content":"hi"}]}'

curl -s http://localhost:8787/v1/read \
  -H "Authorization: Bearer sk_local_localtest1234" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

curl -s http://localhost:8787/v1/embeddings \
  -H "Authorization: Bearer sk_local_localtest1234" \
  -H "Content-Type: application/json" \
  -d '{"model":"BAAI/bge-m3","input":"hello"}'

curl -s http://localhost:8787/v1/rerank \
  -H "Authorization: Bearer sk_local_localtest1234" \
  -H "Content-Type: application/json" \
  -d '{"model":"BAAI/bge-reranker-v2-m3","query":"What is deep learning?","documents":["Deep learning is a branch of machine learning.","It will rain tomorrow."]}'

curl -s http://localhost:8787/v1/send-email \
  -H "Authorization: Bearer sk_local_localtest1234" \
  -H "Content-Type: application/json" \
  -d '{"subject":"smoke test","text":"hello from local dev","to":["a@example.com"]}'

curl -s http://localhost:8787/v1/weather \
  -H "Authorization: Bearer sk_local_localtest1234" \
  -H "Content-Type: application/json" \
  -d '{"location":"广州"}'
# → 200 {"location":{...,"source":"geocode","name":"广州"},"weather":{...}}（open-meteo 免 key，本地 dev 即出真实数据）
```

## 配置

本地密钥放 `.dev.vars`（已 gitignore）；生产用 `wrangler secret put <KEY>`：

| 变量 | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 管理后台密钥（保护 `/admin/api/*`）；网关调用 token 在 `/admin` 后台管理（存 D1） |
| `AGNES_API_KEY` | chat 供应商 agnes（上游模型 agnes-2.0-flash；未注册 model 的回落链也走它） |
| `OPENROUTER_API_KEY` | chat 示例供应商 openrouter |
| `DEEPSEEK_API_KEY` | chat 示例供应商 deepseek-official |
| `SILICONFLOW_API_KEY` | chat 供应商 siliconflow（上游模型 Qwen/Qwen3.5-4B）；embeddings 供应商 siliconflow（上游模型 BAAI/bge-m3）；rerank 供应商 siliconflow（上游模型 BAAI/bge-reranker-v2-m3） |
| `GPTSAPI_API_KEY` | chat 供应商 gptsapi（上游模型 gpt-5.4-nano） |
| `DOTS_API_KEY` | chat 供应商 dots（上游模型 dots3-note-prev，AskDianDian） |
| `ZHIPU_API_KEY` | chat 供应商 zhipu（上游模型 glm-4.7-flash） |
| `SENSENOVA_API_KEY` | chat 供应商 sensenova（上游模型 glm-5.2，商汤托管；逻辑链键名保留 sensenova-6.8-flash-lite） |
| `JINA_API_KEY` | read 供应商 jina + embeddings 供应商 jina（上游模型 jina-embeddings-v5-omni-small）共用 |
| `TAVILY_API_KEY` | read 供应商 tavily |
| `FIRECRAWL_API_KEY` | read 供应商 firecrawl + search 供应商 firecrawl 共用 |
| `ANYSEARCH_API_KEY` | search 供应商 anysearch（可选：官方支持匿名访问，未配置时低限流调用） |
| `SENDGRID_API_KEY` | email 供应商 sendgrid（HTTP API 发信） |
| `EXMAIL_SMTP_PASSWORD` | email 供应商 exmail（腾讯企业邮箱 SMTP 密码；后台开了安全登录时填客户端专用密码） |

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
