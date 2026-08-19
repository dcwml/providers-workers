# /v1/rerank 文档重排序接口使用说明

给一个查询和一组候选文档，按与查询的相关性对文档重排序，返回排序结果与相关性分数。典型用途：RAG 检索后的二次排序。请求/响应形态兼容 Jina/Cohere 的 rerank 风格。

**单 provider 形式**：没有供应商链、没有降级——`model` 映射到哪一家就只跑哪一家，失败即返回 502。这与 chat/read 的链式降级不同，与 embeddings 相同。

- 生产域名：`https://api.oklapzlj.com`
- 路径：`POST /v1/rerank`（仅支持 POST，GET 及其它方法返回 404）
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
| `model` | string | 是 | 逻辑 model 名，见下方 model 映射表；当前仅 `BAAI/bge-reranker-v2-m3` |
| `query` | string | 是 | 查询文本，不能为空字符串 |
| `documents` | string[] | 是 | 待重排序的文档列表，不能为空数组 |
| `top_n` | number | 否 | 只返回相关性最高的前 n 条；缺省返回全部 |
| `return_documents` | boolean | 否 | 是否在结果中带回文档内容；缺省 `false` |

```json
{
  "model": "BAAI/bge-reranker-v2-m3",
  "query": "什么是深度学习？",
  "documents": [
    "深度学习是机器学习的一个分支，基于人工神经网络。",
    "明天天气预报说有雨。",
    "Python 是一种流行的编程语言。"
  ],
  "top_n": 2,
  "return_documents": true
}
```

注意：

- 白名单裁剪——上表之外的字段一律被丢弃，不会发给上游。
- `model` 会被改写为供应商固定的上游 model 后再发送（当前两者同名）。
- 请求体为 `null` 或空 JSON 等价于缺 `model`，按 400 处理。
- 未注册的 `model` 直接 400，**不会**发起上游请求、也不会回落到其它 provider。

## 响应格式

成功（200）时原样透传上游响应：

```json
{
  "id": "01a01804085b7ded85639072b901f30f",
  "results": [
    {
      "index": 0,
      "document": { "text": "深度学习是机器学习的一个分支，基于人工神经网络。" },
      "relevance_score": 0.9994077682495117
    },
    {
      "index": 2,
      "document": { "text": "Python 是一种流行的编程语言。" },
      "relevance_score": 0.00044719857396557927
    }
  ],
  "meta": { "tokens": { "input_tokens": 59, "output_tokens": 0 }, "...": "..." }
}
```

- `results` 按 `relevance_score` **降序**排列（第 0 个最相关）。
- `index` 指向该文档在请求 `documents` 数组中的原始下标。
- `document` 缺省为 `null`；`return_documents: true` 时为 `{ "text": "..." }`。
- 使用 `top_n` 时 `results` 长度等于 `top_n`（不超过 documents 数量）。
- `meta` 为上游用量统计，原样透传。

## 错误码速查

| 状态码 | code | message | 原因 |
| --- | --- | --- | --- |
| 401 | — | `unauthorized` | token 缺失或错误 |
| 400 | `invalid_json` | `invalid JSON body` | 请求体不是合法 JSON |
| 400 | `missing_model` | `model is required` | `model` 缺失或为空串 |
| 400 | `invalid_input` | `query must be a non-empty string and documents must be a non-empty array` | `query` 缺失/空串，或 `documents` 缺失/空数组 |
| 400 | `model_not_found` | `model not found: xxx; valid models: BAAI/bge-reranker-v2-m3` | `model` 未注册（无回落） |
| 400 | `unknown_provider` | `unknown provider: xxx; valid providers: siliconflow` | `?provider=` 传了未知值 |
| 404 | — | `not found` | 方法不是 POST，或路径不对 |
| 502 | `provider_failed` | `rerank provider failed` | 上游失败，看 `provider_errors` 定位 |

502 示例：

```json
{
  "error": {
    "message": "rerank provider failed",
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
- 不可重试错误直接失败：未配置 API key、上游 4xx、响应 `results` 为空。

### model 映射

| 逻辑 model | provider | 上游 model |
| --- | --- | --- |
| `BAAI/bge-reranker-v2-m3` | siliconflow | `BAAI/bge-reranker-v2-m3` |

## 供应商隔离参数（调试用）

URL 追加 `?provider=<id>` 可强制只跑指定的一家，用于排查单家供应商问题：

```
POST /v1/rerank?provider=siliconflow
```

当前合法取值只有 `siliconflow`，未知取值直接 400。正常业务调用不要带此参数。

## 调用示例

```bash
export GATEWAY_TOKEN="<向管理员索取>"

# 基本调用
curl -X POST "https://api.oklapzlj.com/v1/rerank" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "BAAI/bge-reranker-v2-m3",
    "query": "What is deep learning?",
    "documents": [
      "Deep learning is a branch of machine learning based on artificial neural networks.",
      "The weather forecast says it will rain tomorrow."
    ]
  }'
# → 200，results 按相关性降序

# 带可选参数：只要 top 2，并带回文档内容
curl -X POST "https://api.oklapzlj.com/v1/rerank" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "BAAI/bge-reranker-v2-m3",
    "query": "什么是深度学习？",
    "documents": ["深度学习是机器学习的一个分支。", "明天有雨。"],
    "top_n": 2,
    "return_documents": true
  }'

# 错误示例：未注册的 model（无回落，直接 400）
curl -X POST "https://api.oklapzlj.com/v1/rerank" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"nope","query":"q","documents":["a"]}'
# → 400 {"error":{"message":"model not found: nope; valid models: BAAI/bge-reranker-v2-m3","type":"invalid_request_error","code":"model_not_found"}}
```

## 生产现状（2026-08-19 实测）

- siliconflow 已配置（与 chat/embeddings 共用同一个 `SILICONFLOW_API_KEY`），生产验证通过：中英文文档、`top_n`、`return_documents` 均正常。
- rerank 响应速度较快，未观察到 embeddings 首次调用那种冷启动延迟。
