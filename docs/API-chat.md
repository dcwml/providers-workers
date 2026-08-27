# /v1/chat/completions 对话接口使用说明

OpenAI 兼容的 chat 接口（仅非流式）。按 `model` 选择一条写死的供应商链，链内逐家重试与降级，第一家成功即把其响应**原样透传**返回。

- 生产域名：`https://api.oklapzlj.com`
- 路径：`POST /v1/chat/completions`（仅支持 POST，GET 及其它方法返回 404）
- 请求体：`application/json`
- 成功响应：`200`，JSON，上游响应原样透传（不改任何字段，包括 `model`）
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
| `model` | string | 是 | 逻辑 model 名，决定走哪条供应商链，见下方映射表 |
| `messages` | array | 是 | 非空消息数组；`role` 支持 `system` / `user` / `assistant` / `tool` |
| `stream` | boolean | 否 | 只允许缺省或 `false`；传 `true` 直接 400 |
| `tools` / `tool_choice` | — | 否 | OpenAI 工具调用字段 |
| `response_format` | object | 否 | 支持 `json_object` 与 `json_schema` 两种 type |
| 其它字段 | — | 否 | 其余 OpenAI 字段原样透传（供应商不支持时按能力裁剪） |

```json
{
  "model": "agnes-2.0-flash",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "你好" }
  ]
}
```

注意：请求体为 `null` 或空 JSON 等价于缺 `model`，按 400 处理。

### 能力裁剪（发送前自动进行）

每家供应商声明四项能力（systemPrompt / tools / jsonObject / jsonSchema，均经实测确认）。发送前网关按目标供应商的能力裁剪请求：不支持的参数直接删除；`response_format.type: json_schema` 不支持时降级为 `json_object`；不支持 system 消息时并入首条 user 消息；随后把 `model` 改写为该供应商的上游 model。链内 agnes / gptsapi / siliconflow / sensenova 四项能力全部支持；zhipu 不支持 `jsonSchema`（`glm-4.7-flash` 请求带 `json_schema` 会降级为 `json_object`），其余三项支持。

## 响应格式

成功（200）时原样透传上游响应。实测示例（`agnes-2.0-flash`，节选）：

```json
{
  "id": "e9777f1cea9643aba1535f45cbe6dccf",
  "created": 1787111307,
  "model": "agnes-2.0-flash",
  "object": "chat.completion",
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "content": "\n\nOK",
        "role": "assistant",
        "reasoning_content": "..."
      }
    }
  ],
  "usage": { "completion_tokens": 16, "prompt_tokens": 289, "total_tokens": 305 }
}
```

注意：

- `model` 字段是**上游 model 名**（透传不改写）。
- `reasoning_content`、`provider_specific_fields` 等是上游特有字段，同样原样透传；不同供应商返回的字段集合可能不同。
- 降级换家后，响应来自最终成功的那一家，字段风格随该上游。

## 错误码速查

| 状态码 | code | message | 原因 |
| --- | --- | --- | --- |
| 401 | — | `unauthorized` | token 缺失或错误 |
| 400 | `invalid_json` | `invalid JSON body` | 请求体不是合法 JSON |
| 400 | `missing_model` | `model is required` | `model` 缺失或为空串 |
| 400 | `invalid_messages` | `messages must be a non-empty array` | `messages` 缺失或空数组 |
| 400 | `stream_not_supported` | `streaming is not supported` | `stream: true` |
| 400 | `unknown_provider` | `unknown provider: xxx; valid providers: agnes, gptsapi, siliconflow, zhipu, sensenova` | `?provider=` 传了未知值 |
| 404 | — | `not found` | 方法不是 POST，或路径不对 |
| 502 | `all_providers_failed` | `all providers failed` | 整条链全部失败，看 `provider_errors` 定位 |

502 示例：

```json
{
  "error": {
    "message": "all providers failed",
    "type": "upstream_error",
    "code": "all_providers_failed",
    "provider_errors": [
      { "provider": "gptsapi", "message": "..." },
      { "provider": "agnes", "message": "..." },
      { "provider": "siliconflow", "message": "SILICONFLOW_API_KEY is not configured" }
    ]
  }
}
```

## 链式降级与重试

- `model` → 链映射（数组顺序即降级顺序）：

| 逻辑 model | 供应商链（降级顺序） |
| --- | --- |
| `agnes-2.0-flash` | agnes → gptsapi → siliconflow → sensenova → zhipu |
| `Qwen/Qwen3-8B` | siliconflow → agnes → gptsapi → sensenova → zhipu |
| `gpt-5.4-nano` | gptsapi → agnes → siliconflow → sensenova → zhipu |
| `glm-4.7-flash` | zhipu → agnes → gptsapi → siliconflow → sensenova |
| `sensenova-6.8-flash-lite` | sensenova → agnes → gptsapi → siliconflow → zhipu |
| 其它任意未注册 model | agnes（统一回落链） |

注意与 embeddings/rerank 的区别：chat 对未注册的 model **不报 400**，而是统一回落到 agnes 单家链。

- 单家内部：最多 3 次尝试（首次 + 2 次重试），重试间隔 1 秒；每次上游请求 30 秒超时。
- 仅可重试错误会触发重试：上游 5xx / 429、网络错误、响应非 JSON。
- 不可重试错误直接放弃该家、换下一家：未配置 API key、上游 4xx、提取内容为空。
- 第一家成功即返回；整条链全挂 → 502，`provider_errors` 给出每家的具体失败原因。

### provider 与上游 model 对照

| provider | 上游 model |
| --- | --- |
| agnes | `agnes-2.0-flash` |
| gptsapi | `gpt-5.4-nano` |
| siliconflow | `Qwen/Qwen3.5-4B` |
| zhipu | `glm-4.7-flash` |
| sensenova | `glm-5.2`（商汤托管；逻辑链键名保留 `sensenova-6.8-flash-lite`） |

注意：逻辑 model `Qwen/Qwen3-8B` 的键名保留旧称以兼容既有调用方，其 siliconflow 上游已换为 `Qwen/Qwen3.5-4B`——响应 `model` 字段透传显示的是新上游名；`sensenova-6.8-flash-lite` 同理，其 sensenova 上游已换为商汤托管的 `glm-5.2`（思考字段 `reasoning_content`，单次实测 1-11s，四项能力全支持）。`glm-4.7-flash` 上游默认开启思考模式（单次约 38–49s，超网关 30s 超时上限），不带 `thinking` 参数的默认请求会超时并降级到链内下一家；调用方显式传 `thinking: {"type": "disabled"}` 可透传生效。商汤工作区配额窗口较紧，连续请求易 429 `insufficient_quota`（分钟级恢复；网关对 429 按 1s 间隔重试 2 次，可能仍在配额窗口内→耗尽后降级下家）。链扩为 5 家后，全链失败的最坏耗时显著变长（每家最多 3 次×30s），调用方 HTTP 客户端需设置足够超时。

（代码中另有 openrouter、deepseek-official 两家供应商文件，当前未启用在任何链中，属预留示例。）

## 供应商隔离参数（调试用）

URL 追加 `?provider=<id>` 可强制只跑指定的一家，**不做降级**，用于排查单家供应商问题：

```
POST /v1/chat/completions?provider=agnes
POST /v1/chat/completions?provider=gptsapi
POST /v1/chat/completions?provider=siliconflow
POST /v1/chat/completions?provider=zhipu
POST /v1/chat/completions?provider=sensenova
```

未知取值直接 400 并在 message 里列出合法 id。正常业务调用不要带此参数。

## 调用示例

```bash
export GATEWAY_TOKEN="<向管理员索取>"

# 基本调用
curl -X POST "https://api.oklapzlj.com/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "你好" }]
  }'
# → 200，OpenAI 风格响应体

# 隔离测试单家供应商（不降级）
curl -X POST "https://api.oklapzlj.com/v1/chat/completions?provider=siliconflow" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3-8B",
    "messages": [{ "role": "user", "content": "你好" }]
  }'

# 错误示例：stream 不支持
curl -X POST "https://api.oklapzlj.com/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": true
  }'
# → 400 {"error":{"message":"streaming is not supported","type":"invalid_request_error","code":"stream_not_supported"}}
```

## 生产现状（2026-08-27 实测）

- 五家链内供应商密钥均已配置（含 2026-08-27 上线的 sensenova）。
- `glm-4.7-flash`（`thinking` 关闭）实测 200；上游偶发 429（访问量过大）时重试 2 次后按设计降级到 agnes，均实测确认（2026-08-21）。
- `Qwen/Qwen3-8B` 实测 200，响应 `model` 为 `Qwen/Qwen3.5-4B`（siliconflow 上游已换新模型，逻辑名保留旧称）。
- `sensenova-6.8-flash-lite`（时为 flash-lite 上游）实测 200（2026-08-27）：链路真发总耗时 51.9s（首试 30s 超时 → 重试成功，D1 遥测逐次落库）；`?provider=sensenova` 隔离路径单次 20.8s 成功。
- **上游已切 glm-5.2 + 链扩 5 家（2026-08-27 已上线）**：本地实测 glm-5.2 四项能力全支持（jsonSchema 判别通过）、单次 1-11s；生产实测（2026-08-27，版本 83f651b1）：链路调用 `sensenova-6.8-flash-lite` → 200（6.7s，单次成功），响应 `model` 透传 `glm-5.2`，`reasoning_content` 思考字段正常，D1 遥测逐次落库。
- 慢模型（如默认开思考模式的模型）可能接近 30 秒单次超时上限，触发链内重试或换家，属预期行为。
