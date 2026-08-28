# /v1/search 网页搜索接口使用说明

给一个查询词，返回搜索结果。底层是固定的搜索供应商链 **anysearch → firecrawl**，串行降级，第一家成功即返回。

- 生产域名：`https://api.oklapzlj.com`
- 路径：`POST /v1/search`（仅支持 POST，GET 及其它方法返回 404）
- 请求体：`application/json`
- 成功响应：`200`，JSON（上游响应信封**原样透传**，不改任何字段）
- 失败响应：JSON 错误体 `{ "error": { "message": "...", ... } }`

## 认证

所有请求必须携带 Bearer token：

```
Authorization: Bearer <token>
```

token 由管理员下发（服务端可配置多个有效 token）。token 缺失或不正确返回 `401 {"error":{"message":"unauthorized"}}`。

## 请求格式

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 搜索关键词，非空（纯空白字符按缺失处理） |
| `max_results` | integer | 否 | 返回结果数上限，1-10 的整数；缺省由上游决定（默认 10） |

```json
{
  "query": "Go 1.26 release notes",
  "max_results": 5
}
```

其它字段会被忽略；请求体为 `null` 或空 JSON 等价于缺 `query`，按 400 处理。

## 响应格式

成功（200）：

- `Content-Type: application/json; charset=utf-8`
- 响应体为**当前成功那家供应商**的上游响应信封，原样透传：

anysearch 成功时的信封：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "results": [
      { "title": "...", "url": "https://...", "content": "..." }
    ],
    "metadata": { "total_results": 5, "search_time_ms": 530 }
  }
}
```

字段以上游实际返回为准（`results` 元素常见 `title`/`url`/`content`，部分结果用 `snippet`）。

firecrawl 成功时的信封：

```json
{
  "success": true,
  "data": {
    "web": [
      { "title": "...", "description": "...", "url": "https://..." }
    ]
  },
  "creditsUsed": 2
}
```

两家均以空结果集为正常响应（不算失败）。

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
      { "provider": "anysearch", "message": "..." },
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
| 400 | `query must be a non-empty string` | `query` 缺失、不是字符串或全空白 |
| 400 | `max_results must be an integer between 1 and 10` | `max_results` 不是 1-10 的整数 |
| 400 | `unknown provider: xxx; valid providers: anysearch, firecrawl` | `?provider=` 传了未知值 |
| 404 | `not found` | 方法不是 POST，或路径不对 |
| 502 | `all providers failed` | 整条链全部失败，看 `provider_errors` 定位 |

## 降级与重试机制

- 链顺序固定：**anysearch → firecrawl**。
- 单家内部：最多 3 次尝试（首次 + 2 次重试），重试间隔 1 秒；每次上游请求 30 秒超时。
- 仅可重试错误会触发重试：上游 5xx / 429、网络错误、响应非 JSON、HTTP 200 但信封失败（anysearch `code !== 0`；firecrawl `success !== true`）。
- 不可重试错误直接放弃该家：上游其它 4xx。
- 密钥说明：anysearch 官方支持匿名访问（低限流），未配置 `ANYSEARCH_API_KEY` 时照常调用，配置后才带 `Authorization: Bearer`；firecrawl 必须配 key，未配置 `FIRECRAWL_API_KEY` 时直接跳过该家换下家。

## 供应商隔离参数（调试用）

URL 追加 `?provider=<id>` 可强制只跑指定的一家，**不做降级**：

```
POST /v1/search?provider=anysearch
POST /v1/search?provider=firecrawl
```

未知取值直接 400 并在 message 里列出合法 id。正常业务调用不要带此参数。

## 调用示例

```bash
export GATEWAY_TOKEN="<向管理员索取>"

# 正常搜索
curl -X POST "https://api.oklapzlj.com/v1/search" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"Go 1.26 release notes"}'
# → 200，响应体为上游 JSON 信封

# 限制结果数
curl -X POST "https://api.oklapzlj.com/v1/search" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"Go 1.26 release notes","max_results":5}'

# 隔离测试单家供应商（不降级）
curl -X POST "https://api.oklapzlj.com/v1/search?provider=anysearch" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"Go 1.26 release notes"}'

# 错误示例：query 缺失
curl -X POST "https://api.oklapzlj.com/v1/search" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{}'
# → 400 {"error":{"message":"query must be a non-empty string"}}
```
