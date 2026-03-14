-- claude-bridge D1 schema
-- Mirrors the local bun:sqlite schema + auth tables for OAuth persistence

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_sync   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id           TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'empty',
  summary      TEXT,
  last_updated TEXT NOT NULL,
  last_read_at TEXT,
  PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_project ON sync_log(project_id, created_at DESC);

-- OAuth tables for Claude.ai auth persistence across Worker isolates

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_secret TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  client_name   TEXT,
  grant_types   TEXT NOT NULL DEFAULT 'authorization_code',
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope                 TEXT NOT NULL DEFAULT 'mcp:tools',
  state                 TEXT,
  expires_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token      TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'mcp:tools',
  expires_at INTEGER NOT NULL
);
