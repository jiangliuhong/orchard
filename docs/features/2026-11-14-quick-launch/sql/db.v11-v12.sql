-- Review candidate. The migration runner owns the transaction and sets the
-- version only after backfill and validation. This fragment adds structure.
CREATE TABLE quick_launch_groups (
 id TEXT NOT NULL PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40 AND instr(name, '/') = 0),
 name_key TEXT NOT NULL CHECK(length(name_key) BETWEEN 1 AND 40),
 parent_id TEXT REFERENCES quick_launch_groups(id) ON DELETE RESTRICT CHECK(parent_id IS NULL OR parent_id <> id),
 revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX quick_launch_groups_root_name ON quick_launch_groups(name_key) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX quick_launch_groups_sibling_name ON quick_launch_groups(parent_id, name_key) WHERE parent_id IS NOT NULL;
CREATE INDEX quick_launch_groups_by_parent ON quick_launch_groups(parent_id);

CREATE TABLE quick_launches (
 id TEXT NOT NULL PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 note TEXT NOT NULL CHECK(length(note) <= 500),
 group_id TEXT REFERENCES quick_launch_groups(id) ON DELETE RESTRICT,
 target_json TEXT NOT NULL CHECK(CASE WHEN json_valid(target_json) THEN json_type(target_json) = 'object' ELSE 0 END),
 fixed_input_json TEXT NOT NULL CHECK(json_valid(fixed_input_json)),
 input_sources_json TEXT NOT NULL CHECK(CASE WHEN json_valid(input_sources_json) THEN json_type(input_sources_json) = 'object' ELSE 0 END),
 revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX quick_launches_by_group ON quick_launches(group_id);

CREATE TABLE execution_records (
 id TEXT NOT NULL PRIMARY KEY,
 parent_execution_id TEXT REFERENCES execution_records(id) ON DELETE RESTRICT CHECK(parent_execution_id IS NULL OR parent_execution_id <> id),
 launch_id TEXT REFERENCES quick_launches(id) ON DELETE SET NULL,
 source TEXT NOT NULL CHECK(source IN ('quick_launch','workflow_page','script_library','web_bridge','api','other','legacy_unknown')),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow','script','browser_tool')),
 request_scope TEXT NOT NULL,
 request_id TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 config_revision INTEGER CHECK(config_revision IS NULL OR (typeof(config_revision) = 'integer' AND config_revision >= 1)),
 snapshot_ref TEXT NOT NULL,
 underlying_kind TEXT CHECK(underlying_kind IN ('workflow_run','script_test','bridge_call')),
 underlying_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('accepted','queued','running','cancel_requested','succeeded','failed','cancelled','interrupted','start_failed','unknown','unresolved_closed')),
 privacy_policy TEXT NOT NULL CHECK(privacy_policy IN ('standard','restricted','legacy_unknown')),
 accepted_at INTEGER NOT NULL,
 started_at INTEGER,
 ended_at INTEGER,
 safe_error_json TEXT CHECK(safe_error_json IS NULL OR CASE WHEN json_valid(safe_error_json) THEN json_type(safe_error_json) = 'object' ELSE 0 END),
 output_availability TEXT NOT NULL CHECK(output_availability IN ('available','restricted','cleared','not_recorded')),
 last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(last_event_sequence) = 'integer' AND last_event_sequence >= 0),
 ended_tracking_reason TEXT,
 CHECK ((underlying_kind IS NULL) = (underlying_id IS NULL)),
 UNIQUE(request_scope, request_id)
);
CREATE UNIQUE INDEX execution_records_underlying_key ON execution_records(underlying_kind, underlying_id) WHERE underlying_id IS NOT NULL;
CREATE UNIQUE INDEX execution_records_one_active_launch ON execution_records(launch_id)
 WHERE launch_id IS NOT NULL AND status IN ('accepted','queued','running','cancel_requested','unknown');
CREATE INDEX execution_records_top_level_time ON execution_records(accepted_at DESC, id DESC) WHERE parent_execution_id IS NULL;
CREATE INDEX execution_records_by_parent ON execution_records(parent_execution_id, accepted_at DESC, id DESC);
CREATE INDEX execution_records_by_launch ON execution_records(launch_id, accepted_at DESC, id DESC);

CREATE TABLE execution_outbox (
 id TEXT NOT NULL PRIMARY KEY,
 execution_id TEXT NOT NULL REFERENCES execution_records(id) ON DELETE RESTRICT,
 operation TEXT NOT NULL CHECK(operation IN ('dispatch','cancel')),
 sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence >= 0),
 state TEXT NOT NULL CHECK(state IN ('pending','claimed','dispatching','settled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts >= 0),
 claim_token TEXT,
 lease_until INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK ((claim_token IS NULL) = (lease_until IS NULL)),
 CHECK (state <> 'claimed' OR claim_token IS NOT NULL),
 UNIQUE(execution_id, operation, sequence)
);
CREATE INDEX execution_outbox_claim ON execution_outbox(state, lease_until, created_at, id);
