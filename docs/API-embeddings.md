# /v1/embeddings 嵌入接口使用说明

OpenAI 兼容的 embeddings 接口：把文本转成向量。**单 provider 形式**：没有供应商链、没有降级——`model` 映射到哪一家就只跑哪一家，失败即返回 502。这与 chat/read 的链式降级不同，与 rerank 相同。

- 生产域名：`https://api.oklapzlj.com`
- 路径：`POST /v1/embeddings`（仅支持 POST，GET 及其它方法返回 404）
- 请求体：`application/json`
- 成功响应：`200`，JSON，上游响应**原样透传**（不改任何字段）
- 失败响应：OpenAI 风格 JSON 错误体 `{ "error": { "message", "type", "code", ... } }`

## 认证

所有请求必须携带 Bearer token：

```
Authorization: Bearer <token>
```

token 由管理员下发（服务端可配置多个有效 token）。token 缺失或不正确返回 `401 {"error":{"message":"unauthorized"}}`。

## 请求格式

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 逻辑 model 名，见下方映射表；当前仅 `BAAI/bge-m3` |
| `input` | string 或 string[] | 是 | 单条文本或文本批量，均不能为空 |
| `encoding_format` | string | 否 | `float`（默认，返回浮点数组）或 `base64` |
| `dimensions` | number | 否 | 输出维度（上游不支持时可能报错，bge-m3 固定 1024 维） |
| `user` | string | 否 | 终端用户标识，透传 |

```json
{
  "model": "BAAI/bge-m3",
  "input": ["你好，世界", "第二条文本"]
}
```

注意：

- 白名单裁剪——上表之外的字段一律被丢弃，不会发给上游。
- `model` 会被改写为供应商固定的上游 model 后再发送（当前两者同名）。
- 请求体为 `null` 或空 JSON 等价于缺 `model`，按 400 处理。
- 未注册的 `model` 直接 400，**不会**发起上游请求、也不会回落到其它 provider。

## 响应格式

成功（200）时原样透传上游响应（OpenAI 标准形态，向量为 1024 维浮点数组）：

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [-0.0118, 0.0220, -0.0367, "...（共 1024 维）"]
    }
  ],
  "model": "BAAI/bge-m3",
  "usage": { "prompt_tokens": 3, "completion_tokens": 0, "total_tokens": 3 }
}
```

- `data` 顺序与 `input` 一一对应，`index` 为原始下标。
- `encoding_format: "base64"` 时 `embedding` 为 base64 字符串。
- `model`、`usage` 等字段均原样透传。

## 错误码速查

| 状态码 | code | message | 原因 |
| --- | --- | --- | --- |
| 401 | — | `unauthorized` | token 缺失或错误 |
| 400 | `invalid_json` | `invalid JSON body` | 请求体不是合法 JSON |
| 400 | `missing_model` | `model is required` | `model` 缺失或为空串 |
| 400 | `invalid_input` | `input must be a non-empty string or a non-empty array` | `input` 缺失、空串或空数组 |
| 400 | `model_not_found` | `model not found: xxx; valid models: BAAI/bge-m3` | `model` 未注册（无回落） |
| 400 | `unknown_provider` | `unknown provider: xxx; valid providers: siliconflow` | `?provider=` 传了未知值 |
| 404 | — | `not found` | 方法不是 POST，或路径不对 |
| 502 | `provider_failed` | `embeddings provider failed` | 上游失败，看 `provider_errors` 定位 |

502 示例：

```json
{
  "error": {
    "message": "embeddings provider failed",
    "type": "upstream_error",
    "code": "provider_failed",
    "provider_errors": [
      { "provider": "siliconflow", "message": "..." }
    ]
  }
}
```

## 单 provider 与重试机制

- **无链、无降级**：`model` 映射命中唯一一家 provider，只跑这一家；失败即 502，不会换别家。
- 单家内部：最多 3 次尝试（首次 + 2 次重试），重试间隔 1 秒；每次上游请求 30 秒超时。
- 仅可重试错误会触发重试：上游 5xx / 429、网络错误、响应非 JSON。
- 不可重试错误直接失败：未配置 API key、上游 4xx、响应 `data` 为空。

### model 映射

| 逻辑 model | provider | 上游 model |
| --- | --- | --- |
| `BAAI/bge-m3` | siliconflow | `BAAI/bge-m3` |

## 供应商隔离参数（调试用）

URL 追加 `?provider=<id>` 可强制只跑指定的一家，用于排查单家供应商问题：

```
POST /v1/embeddings?provider=siliconflow
```

当前合法取值只有 `siliconflow`，未知取值直接 400。正常业务调用不要带此参数。

## 调用示例

```bash
export GATEWAY_TOKEN="<向管理员索取>"

# 单条文本
curl -X POST "https://api.oklapzlj.com/v1/embeddings" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"BAAI/bge-m3","input":"你好，世界"}'
# → 200，data[0].embedding 为 1024 维向量

# 批量文本
curl -X POST "https://api.oklapzlj.com/v1/embeddings" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"BAAI/bge-m3","input":["第一条","第二条"]}'

# 错误示例：未注册的 model（无回落，直接 400）
curl -X POST "https://api.oklapzlj.com/v1/embeddings" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"nope","input":"hi"}'
# → 400 {"error":{"message":"model not found: nope; valid models: BAAI/bge-m3","type":"invalid_request_error","code":"model_not_found"}}
```

## 生产现状（2026-08-18 上线，2026-08-19 实测）

- siliconflow 已配置（与 chat/rerank 共用同一个 `SILICONFLOW_API_KEY`），生产验证通过：单条、批量（含中文）均 200。
- 部署后第一次调用可能遇到约 10 秒的冷启动延迟，其后恢复正常。
