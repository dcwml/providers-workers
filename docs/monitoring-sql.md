# 监控数据 SQL 查询指南

网关把每次调用（`requests`）与每次供应商上游尝试（`provider_attempts`，含重试）写入 D1（库 `providers_db`）。本文给出常用统计查询。

## 如何执行

```bash
# 生产（--remote）
npx wrangler d1 execute providers_db --remote --command "<下面任一条 SQL>"

# 本地（--local）
npx wrangler d1 execute providers_db --local --command "<SQL>"
```

或 Cloudflare 控制台 → Workers & Pages → providers-workers → D1 → providers_db → Console 直接粘贴 SQL。

时间列均为 ISO 字符串（毫秒精度）。查询里用 `datetime(col)` 与 `datetime('now','-N days')` 比较，避免 `T`/空格分隔符的字典序陷阱。

## 表速览

- `requests`：每次网关调用一行。`feature`(chat/read/search/embeddings/rerank/email)、`endpoint`、`model`、`token_id`(关联 tokens，删除后为 NULL)、`status`(最终响应码；401 表示鉴权失败)、`provider_ok`(成功供应商；全失败/非业务失败为 NULL)、`elapsed_ms`。
- `provider_attempts`：每次上游尝试一行（含重试）。`provider`、`model`、`attempt`(第几次)、`result`(ok/retry/fatal)、`elapsed_ms`、`error`。
- `tokens`：token 登记表。`token_mask` 用于人工比对；完整 token 与哈希不入查询结果。

## 查询集

**1. 各供应商近 7 天成功率与平均耗时（判断关停/更换的核心依据）**

```sql
SELECT provider,
       COUNT(*) AS attempts,
       SUM(result = 'ok') AS ok,
       ROUND(100.0 * SUM(result = 'ok') / COUNT(*), 1) AS ok_pct,
       ROUND(AVG(elapsed_ms)) AS avg_ms
FROM provider_attempts
WHERE datetime(created_at) >= datetime('now', '-7 days')
GROUP BY provider
ORDER BY ok_pct;
```

**2. 按天看某家供应商的成败趋势**（把 `agnes` 换成 provider id）

```sql
SELECT date(created_at) AS day,
       COUNT(*) AS attempts,
       SUM(result = 'ok') AS ok,
       SUM(result = 'retry') AS retried
FROM provider_attempts
WHERE provider = 'agnes'
  AND datetime(created_at) >= datetime('now', '-14 days')
GROUP BY day
ORDER BY day;
```

**3. 某家供应商的失败明细**（错误信息 Top）

```sql
SELECT error, COUNT(*) AS n
FROM provider_attempts
WHERE provider = 'agnes'
  AND result != 'ok'
  AND datetime(created_at) >= datetime('now', '-7 days')
GROUP BY error
ORDER BY n DESC
LIMIT 20;
```

**4. 某家最近 50 条失败尝试的时间线**

```sql
SELECT created_at, model, attempt, result, elapsed_ms, error
FROM provider_attempts
WHERE provider = 'agnes' AND result != 'ok'
  AND datetime(created_at) >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 50;
```

**5. 端到端全失败（502）的请求**

```sql
SELECT created_at, feature, model, status
FROM requests
WHERE status = 502
  AND datetime(created_at) >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 50;
```

**6. 上面某条 502 请求的供应商逐家明细**（把 `<request_id>` 换成上一条查到的 request_id——上一条没选出该列时，先 `SELECT request_id FROM requests WHERE status=502 ORDER BY id DESC LIMIT 1;` 取最近一笔；一条都查不到说明库里还没有请求记录，先随便调用一次任一业务接口产生数据再查）

```sql
SELECT provider, attempt, result, elapsed_ms, error
FROM provider_attempts
WHERE request_id = '<request_id>'
ORDER BY id;
```

**7. 成功请求由哪家兜底**（看降级链实际命中分布）

```sql
SELECT feature, provider_ok, COUNT(*) AS n
FROM requests
WHERE status = 200
  AND datetime(created_at) >= datetime('now', '-7 days')
GROUP BY feature, provider_ok
ORDER BY feature, n DESC;
```

**8. 按 token 的调用量与成功率**

```sql
SELECT COALESCE(t.label, '(已删除/401)') AS label,
       COALESCE(t.token_mask, '-') AS mask,
       COUNT(*) AS calls,
       SUM(r.status = 200) AS ok
FROM requests r
LEFT JOIN tokens t ON r.token_id = t.id
WHERE datetime(r.created_at) >= datetime('now', '-30 days')
GROUP BY t.id
ORDER BY calls DESC;
```

**9. 401 探测记录**（有没有人在乱试 token）

```sql
SELECT created_at, endpoint, model
FROM requests
WHERE status = 401
  AND datetime(created_at) >= datetime('now', '-7 days')
ORDER BY created_at DESC
LIMIT 100;
```

**10. 各逻辑 model 的调用量**（近 30 天）

```sql
SELECT feature, model, COUNT(*) AS calls, ROUND(AVG(elapsed_ms)) AS avg_ms
FROM requests
WHERE datetime(created_at) >= datetime('now', '-30 days')
GROUP BY feature, model
ORDER BY calls DESC;
```

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

## 容量提示

每次网关调用至少写 2 行（`requests` 1 行 + 每次上游尝试各 1 行，含重试），D1 免费档每日写入行数上限约 10 万，可据此估算日志留存与调用量上限。
