ALTER TABLE workflow_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_tasks ADD COLUMN policy_key TEXT;
CREATE TABLE IF NOT EXISTS workflow_continuations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  resume_at INTEGER,
  event_name TEXT,
  match_key TEXT,
  payload_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  UNIQUE(run_id, step_key, kind, status)
);
CREATE INDEX IF NOT EXISTS idx_continuations_resume ON workflow_continuations(status, resume_at);
CREATE INDEX IF NOT EXISTS idx_continuations_event ON workflow_continuations(status, event_name, match_key);
CREATE TABLE IF NOT EXISTS scheduling_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  trigger_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  policy_key TEXT,
  retry_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduling_decisions_run ON scheduling_decisions(run_id, created_at);
CREATE TABLE IF NOT EXISTS policy_buckets (
  policy_key TEXT PRIMARY KEY,
  window_start INTEGER,
  window_count INTEGER NOT NULL DEFAULT 0,
  tokens REAL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  active_leases INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS run_links (
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  parent_step_key TEXT NOT NULL,
  child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(parent_run_id, parent_step_key)
);
PRAGMA user_version = 4;
