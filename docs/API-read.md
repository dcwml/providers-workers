# /v1/read 页面读取接口使用说明

给一个 URL，返回该网页的正文内容（Markdown 纯文本）。底层是固定的三家读取供应商链 **jina → tavily → firecrawl**，串行降级，第一家成功即返回。

- 生产域名：`https://api.oklapzlj.com`
- 路径：`POST /v1/read`（仅支持 POST，GET 及其它方法返回 404）
- 请求体：`application/json`
- 成功响应：`200`，正文为 Markdown 纯文本（**不是 JSON**）
- 失败响应：JSON 错误体 `{ "error": { "message": "...", ... } }`

## 认证

所有请求必须携带 Bearer token：

```
Authorization: Bearer <token>
```

token 由管理员下发（服务端可配置多个有效 token）。token 缺失或不正确返回 `401 {"error":{"message":"unauthorized"}}`。

## 请求格式

请求体只认一个字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 要读取的目标页面地址，必须以 `http://` 或 `https://` 开头 |

```json
{
  "url": "https://example.com/some-article"
}
```

其它字段会被忽略；请求体为 `null` 或空 JSON 等价于缺 `url`，按 400 处理。

## 响应格式

成功（200）：

- `Content-Type: text/markdown; charset=utf-8`
- 响应体就是 Markdown 文本，直接取 body 即可，无需解析 JSON。

失败（4xx / 5xx）：

```json
{ "error": { "message": "错误描述" } }
```

502 时额外带 `provider_errors`，逐家记录失败原因：

```json
{
  "error": {
    "message": "all providers failed",
    "provider_errors": [
      { "provider": "jina", "message": "..." },
      { "provider": "tavily", "message": "TAVILY_API_KEY is not configured" },
      { "provider": "firecrawl", "message": "..." }
    ]
  }
}
```

## 错误码速查

| 状态码 | message | 原因 |
| --- | --- | --- |
| 401 | `unauthorized` | token 缺失或错误 |
| 400 | `invalid JSON body` | 请求体不是合法 JSON |
| 400 | `url must be an http(s) URL` | `url` 缺失、不是字符串、或不以 http(s):// 开头 |
| 400 | `unknown provider: xxx; valid providers: jina, tavily, firecrawl` | `?provider=` 传了未知值 |
| 404 | `not found` | 方法不是 POST，或路径不对 |
| 502 | `all providers failed` | 整条链全部失败，看 `provider_errors` 定位 |

## 降级与重试机制

- 链顺序固定：**jina → tavily → firecrawl**，第一家成功即返回，不会并行请求。
- 单家内部：最多 3 次尝试（首次 + 2 次重试），重试间隔 1 秒；每次上游请求 30 秒超时。
- 仅可重试错误会触发重试：上游 5xx / 429、网络错误、响应非 JSON。
- 不可重试错误直接放弃该家、换下一家：未配置 API key、上游 4xx、提取内容为空。
- 三家全挂 → 502，`provider_errors` 给出每家的具体失败原因。

## 供应商隔离参数（调试用）

URL 追加 `?provider=<id>` 可强制只跑指定的一家，**不做降级**，用于排查单家供应商问题：

```
POST /v1/read?provider=jina
POST /v1/read?provider=tavily
POST /v1/read?provider=firecrawl
```

未知取值直接 400 并在 message 里列出合法 id。正常业务调用不要带此参数。

## 调用示例

```bash
export GATEWAY_TOKEN="<向管理员索取>"

# 正常读取
curl -X POST "https://api.oklapzlj.com/v1/read" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
# → 200，响应体为 Markdown 文本

# 隔离测试单家供应商（不降级）
curl -X POST "https://api.oklapzlj.com/v1/read?provider=firecrawl" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{"url":"https://example.com"}'

# 错误示例：url 非法
curl -X POST "https://api.oklapzlj.com/v1/read" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{"url":"not-a-url"}'
# → 400 {"error":{"message":"url must be an http(s) URL"}}
```

## 生产现状（2026-08-18 实测）

- `jina`、`firecrawl` 已配置并验证可用；`tavily` 未配置 `TAVILY_API_KEY`，在链中会被快速跳过（隔离调用时会返回 502 并在 provider_errors 中说明）。
- 正常链路（不带 `?provider`）实测 200 返回 Markdown。
