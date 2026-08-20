-- token 管理 + 请求/供应商尝试监控（spec: docs/superpowers/specs/2026-08-19-d1-token-admin-monitoring-design.md）
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL DEFAULT '',
  token_mask TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  feature TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  token_id INTEGER REFERENCES tokens(id) ON DELETE SET NULL,
  status INTEGER NOT NULL,
  provider_ok TEXT,
  elapsed_ms INTEGER
);
CREATE INDEX idx_requests_created ON requests(created_at);
CREATE INDEX idx_requests_token ON requests(token_id);

CREATE TABLE provider_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  feature TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('ok','retry','fatal')),
  elapsed_ms INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX idx_attempts_provider_created ON provider_attempts(provider, created_at);
CREATE INDEX idx_attempts_request ON provider_attempts(request_id);
