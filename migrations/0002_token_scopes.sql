-- token 接口权限：scopes 为逗号分隔的接口名（chat/read/search/embeddings/rerank/email）。
-- 空串 = 不限制（可调用全部业务接口），存量 token 默认行为不变。
ALTER TABLE tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT '';
