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

发件人由网关内置（各供应商不同：exmail 为 `Infility <info@infility.cn>`，sendgrid 为 `Provider <provider@em8487.oklapzlj.com>`——SendGrid 认证发件地址），请求体**不接受** `from` 字段。不支持附件（attachment）。

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

截至 2026-08-27（生产已部署，api.oklapzlj.com 实测）：

- **sendgrid**：生产实测真发成功，发件人 `Provider <provider@em8487.oklapzlj.com>`（SendGrid 认证发件地址，81bdf08 版本起生效，message_id=2utS9gC0Tb-SpuEarPw8Pg）；生产 secret `SENDGRID_API_KEY` 已配置；遥测落库正常（exmail=fatal → sendgrid=ok）。
- **exmail**：`EXMAIL_SMTP_PASSWORD` 未配置，缺 key 自动跳过（不影响 sendgrid 兜底）。配置后 SMTP 链路即可启用（465/SSL，AUTH PLAIN 优先 + LOGIN 回退）；发送前建议先用 `?provider=exmail` 隔离验证。
