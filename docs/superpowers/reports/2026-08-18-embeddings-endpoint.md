# /v1/embeddings 接口上线记录（2026-08-18）

## 范围

新增 OpenAI 兼容 embeddings 端点 `POST /v1/embeddings`，首个 provider 为 siliconflow（上游固定模型 `BAAI/bge-m3`，复用 chat 的 `SILICONFLOW_API_KEY` 与 base url）。

## 设计要点（与 chat/read 的区别）

- **单 provider 形式**：`src/embeddings/models.ts` 按逻辑 model 写死映射到单个 provider——无链、无降级，失败即失败（单家内部仍沿用 `DEFAULT_RETRY` 3 次/1s 重试）。
- **未注册 model → 400 `model_not_found`**（不像 chat 有 FALLBACK_CHAIN）。当前唯一逻辑 model：`BAAI/bge-m3`。
- 请求白名单裁剪：只发 OpenAI embeddings 标准字段（input/encoding_format/dimensions/user），`model` 改写为上游固定 model；其余字段裁掉。
- 响应原样透传；上游 `data` 为空数组按 `NonRetryableError`（对齐"提取内容为空"统一口径）。
- 错误体用 chat 的 OpenAI 风格：单家失败 502，code=`provider_failed`，附 `provider_errors`。
- 支持 `?provider=` 覆盖参数（与 chat/read 一致，测试隔离用）。

## 新增/改动文件

- 新增：`src/embeddings/{types,models,runner}.ts`、`src/embeddings/providers/siliconflow.ts`
- 新增测试：`test/embeddings/{providers,runner}.test.ts`，`test/index.test.ts` 增 embeddings 路由用例
- 改动：`src/index.ts`（路由+handleEmbeddings）、`src/log.ts`（feature 联合加 "embeddings"）
- 文档：`README.md`（端点表/重试策略/冒烟示例/配置表）、`agents.md`（目录树/供应商实现/链/错误体约定）、`.dev.vars.example`（共用 key 注释）
- 顺带修复：`test/chat/chains.test.ts` 历史遗留断言（HEAD 即红）——按用户确认保留三家降级链，改测试匹配代码

## 验证

- `npm run typecheck` 干净；`npm test` 14 文件 130/130 全绿。
- 真实上游直连（curl，密钥取自 .dev.vars）：字符串 input、批量数组 input、中文文本（unicode 转义）均 200。
- wrangler dev 端到端：200 透传真实向量（0.8s）；未知 model → 400 model_not_found；错误 token → 401。确认 wrangler 能解析 `KEY = "value"` 带空格引号的 .dev.vars 格式。

## 坑备忘

- .dev.vars 用 `KEY = "value"`（等号带空格+引号）格式：shell 里 `grep '^KEY='` 取不到值，须 `sed 's/^[^=]*= *//' | tr -d '"'`。
- Windows bash 下 curl -d 直接内嵌中文可能编码破损导致上游 400（参数无效）；用 \u 转义或 --data-binary @文件 验证才准。网关本身不受影响（透传客户端 UTF-8 字节）。
- wrangler dev 杀进程要杀整棵树（cmd→node wrangler.js→cli.js→workerd），只杀 npm 父进程会残留并自动重启 workerd。

## 待办（用户）

- 生产 secret 无需新增（`SILICONFLOW_API_KEY` 已有）；部署 `npm run deploy` 即生效。
- 如需第二个 embeddings provider：新建 `src/embeddings/providers/<id>.ts` + `models.ts` 里给相应逻辑 model 改映射（当前每个 model 只映射一家）。
