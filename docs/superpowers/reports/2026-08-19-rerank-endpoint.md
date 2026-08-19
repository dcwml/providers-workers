# /v1/rerank 接口实现记录（2026-08-19）

## 需求

在 providers 网关新增重排序接口 `/v1/rerank`，形态与 embeddings 完全一致：

- 结构上支持多 provider，但**单 provider 形式**：无链、无降级，失败即失败。
- 每个 rerank provider 固定上游 model，做 model 映射；未注册的 model 直接 400（`model_not_found`），不回落。
- 首个 provider：siliconflow，复用 chat/embeddings 的同一个 `SILICONFLOW_API_KEY` 与 base URL，上游模型 `BAAI/bge-reranker-v2-m3`。

## 上游契约（实测确认，非文档推断）

直接 curl `https://api.siliconflow.cn/v1/rerank`（密钥取自 .dev.vars）：

- 请求：`{model, query, documents, top_n?, return_documents?}`。
- 成功 200：`{id, results: [{index, document, relevance_score}], meta}`；`results` 按相关性降序；`return_documents` 缺省 false 时 `document` 为 null，为 true 时为 `{text}`。
- 错误：400 返回 `{code, message, data}`（如空 documents → 20015，model 不存在 → 20012），走既有 `classifyHttpStatus` 归为不可重试。

## 实现

全部仿照 embeddings 模块结构：

| 文件 | 内容 |
| --- | --- |
| `src/rerank/types.ts` | `RerankRequest`（query/documents + 可选 top_n/return_documents）、`RerankProvider` 接口 |
| `src/rerank/providers/siliconflow.ts` | 自包含 provider：BASE_URL=`https://api.siliconflow.cn/v1`，UPSTREAM_MODEL=`BAAI/bge-reranker-v2-m3`，ENV_KEY=`SILICONFLOW_API_KEY`；白名单裁剪（query/documents/top_n/return_documents），model 改写；失败分类统一口径；`results` 为空数组 → `NonRetryableError` |
| `src/rerank/models.ts` | `MODELS` 单 provider 映射 + `RERANK_MODEL_IDS` + `getRerankProviderByModel` + `?provider=` 覆盖用的 `getRerankProviderById`/`RERANK_PROVIDER_IDS` |
| `src/rerank/runner.ts` | `runRerank(req, env, provider, retryOverrides?)`：单家执行，保留 DEFAULT_RETRY（3 次/1s）单家重试，无跨家降级；失败 → `{kind:"failed", status:502, errors:[...]}` |
| `src/log.ts` | feature 联合类型加 `"rerank"` |
| `src/index.ts` | `handleRerank`（结构镜像 handleEmbeddings）+ 路由 `/v1/rerank`；校验：model 必填（`missing_model`）、query 非空字符串且 documents 非空数组（`invalid_input`）；错误体沿用 OpenAI 风格（502 时 code=`provider_failed`） |

请求体形态采用 Jina/Cohere 风格（`query`/`documents`/`top_n`/`return_documents`），与 SiliconFlow 上游一致，响应原样透传。

## 测试

- `test/rerank/providers.test.ts`（9 例）：URL/body 白名单断言（bogus 字段裁剪、model 改写）、可选字段缺省不带、缺 key、429/400/网络错/非 JSON/空 results/null JSON 各失败路径。
- `test/rerank/runner.test.ts`（7 例）：model 映射（含未知 model 无回落 undefined）、ID 列表、成功透传、可重试错 3 次后 502、不可重试错 1 次即 502、日志 `[rerank]` 前缀。
- `test/index.test.ts` 扩展（+11 例）：200 透传、invalid JSON/null body/缺 model/缺或空 query/documents → 400、未知 model → 400 `model_not_found`、失败 → 502 `provider_failed`、`?provider=siliconflow` 覆盖与 `?provider=bogus` → 400 `unknown_provider`。

验收：`npm run typecheck` 干净；`npm test` 16 文件 155 例全绿。

## 本地 e2e（wrangler dev，真实上游）

- 中文文档 + top_n=2 + return_documents=true → 200，results 排序正确、document.text 返回。
- 未知 model → 400 model_not_found；`?provider=bogus` → 400 unknown_provider；缺 documents → 400 invalid_input；错 token → 401；`?provider=siliconflow` → 200。
- 冒烟后已整棵杀掉 providers 的 wrangler dev 进程树（npm→cmd→node→workerd×2+esbuild），8787 端口确认释放；8799 上用户自己的 suanning-zhanbu dev 服务未触碰。

## 文档同步

- `README.md`：简介、端点表、重试策略例外、冒烟示例、配置表（SILICONFLOW_API_KEY 三用途）。
- `agents.md`：简介、目录树、供应商实现约定（rerank 白名单/空 results）、供应商链、错误体口径。
- `.dev.vars.example`：SILICONFLOW_API_KEY 注释补 rerank 用途。

## 踩坑备忘

- `.dev.vars` 是 `KEY = "value"` 格式（等号带空格、值带引号），shell 提取须 `sed 's/^[^=]*= *//' | tr -d '"\r '`。
- Windows bash 下 curl -d 内嵌中文会编码破损，一律 `printf > 文件` + `--data-binary @文件`。
- powershell 单行命令里的 `$_` 若外层用双引号会被 bash 吞掉，须外层单引号包裹。
- 杀 wrangler dev 必须整棵进程树逐 PID 杀（taskkill //F //T），杀后 netstat 验证 8787 无 LISTENING。

## 待办

- 提交 + 推送（自动部署）后，用生产域名/token 验证 `/v1/rerank`（等用户指令）。
