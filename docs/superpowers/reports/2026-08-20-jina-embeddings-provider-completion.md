# Jina embeddings provider 完成报告（2026-08-20）

## 交付物

| 任务 | 提交 | 文件 |
| --- | --- | --- |
| Task 1 基线修复 | **无本计划新提交**——该修复已由并行 zhipu chat 任务以相同方式落地：`c4425f6` `test: sync siliconflow assertion and README model name with c344005`（把 `c344005` 引入的 siliconflow 上游 model 名变更同步到测试断言与 README，消除红基线） | `test/chat/providers.test.ts`、`README.md` |
| Task 2 jina provider + types 加宽 | `5a144b2` `feat: add jina embeddings provider with multimodal input and task passthrough` | `src/embeddings/providers/jina.ts`（新增，自包含：BASE_URL/UPSTREAM_MODEL/ENV_KEY=JINA_API_KEY）、`src/embeddings/types.ts`（input 类型加宽多模态对象 + task/normalized 字段）、`test/embeddings/providers.test.ts`（+9 测试：缺 key / 网络错 / 可重试与不可重试状态码 / 非 JSON / 空 data / 成功提取与字段裁剪） |
| Task 3 models 注册 + runner 测试 | `1f13acf` `feat: register jina-embeddings-v5-omni-small logical model` | `src/embeddings/models.ts`（`"jina-embeddings-v5-omni-small": jina`，单 provider 无链）、`test/embeddings/runner.test.ts`（+1 测试） |
| Task 4 文档三处 + 补一行修正 | `4eb223f` `docs: document jina embeddings provider`；`cb61baa` `docs: sync embeddings model_not_found example with registered models` | `docs/API-embeddings.md`（请求格式表/白名单例外/注意事项/映射表/错误码/隔离参数/示例七处 + model_not_found 示例同步）、`README.md`（端点表 + 配置表 JINA_API_KEY 独立行）、`.dev.vars.example`（JINA_API_KEY 注释注明 read+embeddings 共用） |
| Task 5 完成报告 | 本文件（`docs: add jina embeddings provider completion report`，本计划收尾提交） | `docs/superpowers/reports/2026-08-20-jina-embeddings-provider-completion.md` |

规划文档：设计 spec `2ae5519`、实施计划 `1527f0f`。zhipu chat provider 已由用户并行执行完成（`5e8302c..66014c1`），与本任务互不阻塞；其计划中的「基线修复」即本计划 Task 1 的同一修复，已在 `c344005`/`c4425f6` 落地。

## 上游实测结论

模型 `jina-embeddings-v5-omni-small`，密钥取自 `.dev.vars`（本机 DNS 污染，实测走 `127.0.0.1:7890` 代理；生产 Workers 出网不受影响）。

设计期实测（spec §2）：

- 不带 `task` 可正常调用（200，走 Jina 默认行为）；`task: "retrieval.query"` + `normalized: true` 亦正常（均生效）
- 多模态对象输入 `[{text}, {image: <base64>}]` 返回对应数量 1024 维向量；usage 区分 `prompt_tokens` / `image_tokens`
- 响应标准 OpenAI 风格（`data[].embedding` + `model` + `usage`），现有提取逻辑直接适用
- 用户提供的 key 与 `.dev.vars` 原 `JINA_API_KEY`（read 链在用）不是同一把；定案为新 key 覆盖、read + embeddings 共用

实施期补测（Task 4；实测结论已记录于本报告与 `docs/API-embeddings.md`，dimensions/encoding_format 两项：HTTP 200 + 512 维 / base64 字符串；原始响应为临时产物未归档，如需复测按 API-embeddings.md 注意事项中的参数重放即可）：

- `dimensions=512` → HTTP 200，返回 **512 维**向量（`usage.total_tokens: 4`）——**受支持，Matryoshka 降维生效**
- `encoding_format=base64` → HTTP 200，`embedding` 为 **base64 字符串**而非浮点数组——**受支持**

两条结论已写入 `docs/API-embeddings.md` 注意事项（L47）。

## 验收结果

全量验收（Task 5 执行，2026-08-20）：

- `npm run typecheck`：干净，无输出无报错
- `npm test`：**208/208 全绿**（18 个测试文件，无失败无跳过）
- 计划基线 191 + jina 9 + runner 1 = 201；实际 208 的差异来自并行 zhipu chat 任务新增的 7 个测试（基线变为 198，198 + 9 + 1 = 208），与 spec §9「以实际为准」口径一致
- `git status --short`：仅 2 个既有的 2026-08-17 未跟踪报告文件（`2026-08-17-read-jina-local-smoke.md`、`2026-08-17-read-provider-override-and-firecrawl.md`），无本任务遗漏改动

spec §9 验收标准逐条对照：

1. **`npm run typecheck && npm test` 全绿** — 通过。typecheck 干净；208/208 全绿（实际数，spec 注明「以实际为准」；与 201 的差异见上，系并行任务所致，非本计划引入）。
2. **`README` / `.dev.vars.example` / `docs/API-embeddings.md` 与实现一致** — 通过。逐项核对：README L11 端点表 `jina-embeddings-v5-omni-small` → jina（多模态，task/normalized 透传）与 `src/embeddings/models.ts` 注册一致；README L79 与 `.dev.vars.example` L18-19 的 `JINA_API_KEY`（read + embeddings 共用）与 provider `ENV_KEY` 一致；API 文档请求格式表（task/normalized 仅 jina）、白名单例外（标准四字段 + jina 两字段）、映射表、错误码（`model_not_found` valid models 含两个逻辑 model、`unknown_provider` valid providers 含 `siliconflow, jina`，与 `EMBEDDING_MODEL_IDS`/`EMBEDDINGS_PROVIDER_IDS` 实际输出一致）、隔离参数合法取值，均与 `src/embeddings/providers/jina.ts` 及 `models.ts` 实现一致。
3. **`dimensions` / `encoding_format` 实测结论已写入 API 文档** — 通过。`docs/API-embeddings.md` L47：「jina 的 `dimensions` 与 `encoding_format` 实测：支持——dimensions=512 生效返回 512 维 / encoding_format=base64 生效返回 base64 字符串。」依据为 Task 4 两轮线上实测（见上「实施期补测」）。

## 遗留与后续

- 生产部署（用户执行）：git push 自动部署；线上验证三连——
  1. `curl -X POST "https://api.oklapzlj.com/v1/embeddings" -H "Authorization: Bearer <GATEWAY_TOKEN>" -H "Content-Type: application/json" -d '{"model":"jina-embeddings-v5-omni-small","task":"retrieval.query","input":"hello"}'` → 200 且 1024 维
  2. 同 body 追加 `?provider=jina` 再验一次（隔离参数路径）
  3. **/v1/read 回归**（生产 JINA_API_KEY 已换新值且 read 与 embeddings 共用）：`curl -X POST "https://api.oklapzlj.com/v1/read" -H "Authorization: Bearer <GATEWAY_TOKEN>" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'` → 200，确认 read 链未受换 key 影响
- 本 key 已出现在聊天记录，如介意可在 Jina 后台轮换（更新 .dev.vars 与生产 secret 即可，代码不动）
- zhipu chat provider 已由用户并行执行完成（与本任务互不阻塞；其计划中的「基线修复」即本计划 Task 1 的同一修复，已在 c344005/c4425f6 落地）
- README 配置表缺 agnes 行（既有遗漏，未处理）
