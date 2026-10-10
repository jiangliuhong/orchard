-- Approved workflow version integrity metadata migration.
-- Keep the existing step/task and trigger/schedule tables for compatibility.
ALTER TABLE workflow_versions ADD COLUMN execution_config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_versions ADD COLUMN artifact_hash TEXT;
ALTER TABLE workflow_versions ADD COLUMN activated_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow_created ON workflow_versions(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_claim_until ON runs(status, claim_until);
CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence ON run_events(run_id, sequence_no);
PRAGMA user_version = 3;
