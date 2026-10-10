CREATE TABLE IF NOT EXISTS pending_commands (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  policy_key TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workflow_id, policy_key, status)
);
CREATE TABLE IF NOT EXISTS singleton_locks (
  policy_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_commands_due ON pending_commands(status, expires_at);
PRAGMA user_version = 6;
