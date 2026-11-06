

CREATE TABLE runs_v2 (
 id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),
 input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,
 created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,
 CHECK (
  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)
  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)
 )
);

INSERT INTO runs_v2(id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at)
 SELECT id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;
CREATE INDEX queued_runs ON runs(status,created_at);
PRAGMA user_version = 2;
