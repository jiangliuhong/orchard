export const SCHEMA_VERSION = 8;
export const AGENT_MODEL_SCHEMA = `
CREATE TABLE agent_model_configs (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);
CREATE TABLE agent_model_config_revisions (
 config_id TEXT NOT NULL REFERENCES agent_model_configs(id),
 revision INTEGER NOT NULL CHECK(revision > 0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 description TEXT NOT NULL CHECK(length(description) <= 2000),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(config_id,revision)
);
CREATE TABLE run_agent_bindings (
 run_id TEXT NOT NULL, node_id TEXT NOT NULL,
 config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,node_id),
 FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,
 FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)
);
CREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);
`;
export const MIGRATE_V7_TO_V8 = `${AGENT_MODEL_SCHEMA} PRAGMA user_version = 8;`;
export const RUN_SCHEMA = `
CREATE TABLE runs (
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
`;
export const MIGRATE_V1_TO_V2 = `
${RUN_SCHEMA.replace("CREATE TABLE runs (", "CREATE TABLE runs_v2 (")}
INSERT INTO runs_v2(id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at)
 SELECT id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;
CREATE INDEX queued_runs ON runs(status,created_at);
PRAGMA user_version = 2;
`;
/** §20.1 已审核的增量迁移：对话表、轮次/消息扩列、活动轮次索引扩展。旧关联全部保留为 NULL。 */
export const MIGRATE_V2_TO_V3 = `
CREATE TABLE agent_conversations (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),
 status TEXT NOT NULL CHECK(status IN ('current','archived','needs_rebuild')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 model_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),
 connection_fingerprint TEXT NOT NULL,
 cli_version TEXT,
 backend_ref_json TEXT,
 backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),
 synced_revision INTEGER CHECK(synced_revision >= 0),
 rebuild_from_id TEXT REFERENCES agent_conversations(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK (
  (mode='single' AND context_mode='isolated')
  OR (mode='multi' AND transport='native' AND context_mode='native')
  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')
 )
);
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id)
 WHERE status IN ('current','needs_rebuild');
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);
ALTER TABLE authoring_turns ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);
ALTER TABLE authoring_turns ADD COLUMN backend_turn_id TEXT;
ALTER TABLE authoring_turns ADD COLUMN connection_generation INTEGER;
ALTER TABLE authoring_turns ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'not_sent'
 CHECK(submission_state IN ('not_sent','sending','accepted','settled'));
ALTER TABLE authoring_turns ADD COLUMN input_ref TEXT;
ALTER TABLE authoring_turns ADD COLUMN result_ref TEXT;
ALTER TABLE authoring_messages ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);
DROP INDEX one_active_turn;
CREATE UNIQUE INDEX one_active_turn
 ON authoring_turns(draft_id)
 WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);
CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);
PRAGMA user_version = 3;
`;
/** 历史对话 feature（已审核，见 docs/features/agent-conversations/history-schema-proposal.md）：
 * 重建 agent_conversations 增加 idle 状态、title 与 archived_at；存量 archived 为轮换产物，映射为 idle。
 * 唯一索引收窄为仅 current：needs_rebuild 重建后保留为诊断历史，不再占用当前对话名额。 */
export const MIGRATE_V3_TO_V4 = `
CREATE TABLE agent_conversations_v4 (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),
 status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 model_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),
 connection_fingerprint TEXT NOT NULL,
 cli_version TEXT,
 backend_ref_json TEXT,
 backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),
 synced_revision INTEGER CHECK(synced_revision >= 0),
 rebuild_from_id TEXT REFERENCES agent_conversations_v4(id),
 title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),
 archived_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK (
  (mode='single' AND context_mode='isolated')
  OR (mode='multi' AND transport='native' AND context_mode='native')
  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')
 ),
 CHECK (status != 'archived' OR archived_at IS NOT NULL)
);
INSERT INTO agent_conversations_v4(
 id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,
 transport,connection_fingerprint,cli_version,backend_ref_json,backend_generation,
 synced_revision,rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at)
 SELECT id,draft_id,mode,context_mode,
   CASE status WHEN 'archived' THEN 'idle' ELSE status END,
   provider_id,provider_revision,model_id,transport,connection_fingerprint,cli_version,
   backend_ref_json,backend_generation,synced_revision,rebuild_from_id,
   NULL,
   CASE status WHEN 'archived' THEN updated_at ELSE NULL END,
   created_at,updated_at,last_used_at
 FROM agent_conversations;
DROP TABLE agent_conversations;
ALTER TABLE agent_conversations_v4 RENAME TO agent_conversations;
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id)
 WHERE status = 'current';
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);
CREATE INDEX conversations_by_activity
 ON agent_conversations(draft_id,updated_at DESC,id);
PRAGMA user_version = 4;
`;
export const MIGRATE_V4_TO_V5 = `
CREATE TABLE scripts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 current_draft_version_id TEXT, current_published_version_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE script_versions (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 entry_file TEXT NOT NULL, input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,
 source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
 UNIQUE(script_id,version_no)
);
CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';
CREATE TABLE script_tests (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),
 draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,
 duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)
   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))
);
CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);
CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);
CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts
WHEN NEW.current_draft_version_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;
CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions
WHEN OLD.status='published'
BEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;
PRAGMA user_version = 5;
`;
export const MIGRATE_V5_TO_V6 = `
ALTER TABLE script_versions ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000);
PRAGMA user_version = 6;
`;
export const MIGRATE_V6_TO_V7 = `
CREATE TABLE agent_conversations_v7 (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),
 status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 model_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport = 'native'),
 connection_fingerprint TEXT NOT NULL,
 cli_version TEXT,
 backend_ref_json TEXT,
 backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),
 synced_revision INTEGER CHECK(synced_revision >= 0),
 rebuild_from_id TEXT REFERENCES agent_conversations_v7(id),
 title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),
 archived_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK (
  (mode='single' AND context_mode='isolated')
  OR (mode='multi' AND context_mode='native')
 ),
 CHECK (status != 'archived' OR archived_at IS NOT NULL)
);
INSERT INTO agent_conversations_v7
 SELECT id,draft_id,mode,
   CASE mode WHEN 'single' THEN 'isolated' ELSE 'native' END,
   CASE WHEN transport='legacy' AND mode='multi' AND status!='archived'
     THEN 'needs_rebuild' ELSE status END,
   provider_id,provider_revision,model_id,'native',
   CASE WHEN transport='legacy' THEN '' ELSE connection_fingerprint END,
   cli_version,
   CASE WHEN transport='legacy' THEN NULL ELSE backend_ref_json END,
   backend_generation + CASE WHEN transport='legacy' THEN 1 ELSE 0 END,
   CASE WHEN transport='legacy' THEN NULL ELSE synced_revision END,
   rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at
 FROM agent_conversations;
DROP TABLE agent_conversations;
ALTER TABLE agent_conversations_v7 RENAME TO agent_conversations;
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id) WHERE status='current';
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);
CREATE INDEX conversations_by_activity
 ON agent_conversations(draft_id,updated_at DESC,id);
UPDATE provider_settings
 SET config_json=json_set(config_json,'$.transport','native'),
     revision=revision+1
 WHERE id IN ('codex-cli','pi-cli')
   AND (json_extract(config_json,'$.transport') IS NULL
     OR json_extract(config_json,'$.transport')!='native');
PRAGMA user_version = 7;
`;

export const SCHEMA = `
CREATE TABLE provider_settings (
 id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,
 models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL
);
CREATE TABLE workflows (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE workflow_versions (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,
 definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)
);
CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows
 WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END;
CREATE TABLE drafts (
 id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),
 revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,
 published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE authoring_turns (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,
 base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,
 conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,
 submission_state TEXT NOT NULL DEFAULT 'not_sent'
  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),
 input_ref TEXT, result_ref TEXT
);
CREATE TABLE authoring_messages (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),
 sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 conversation_id TEXT REFERENCES agent_conversations(id),
 UNIQUE(draft_id,sequence)
);
CREATE TABLE agent_conversations (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),
 status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 model_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport = 'native'),
 connection_fingerprint TEXT NOT NULL,
 cli_version TEXT,
 backend_ref_json TEXT,
 backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),
 synced_revision INTEGER CHECK(synced_revision >= 0),
 rebuild_from_id TEXT REFERENCES agent_conversations(id),
 title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),
 archived_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK (
  (mode='single' AND context_mode='isolated')
  OR (mode='multi' AND context_mode='native')
 ),
 CHECK (status != 'archived' OR archived_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id)
 WHERE status = 'current';
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);
CREATE INDEX conversations_by_activity
 ON agent_conversations(draft_id,updated_at DESC,id);
CREATE UNIQUE INDEX one_active_turn
 ON authoring_turns(draft_id)
 WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);
CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);
${RUN_SCHEMA}
CREATE INDEX queued_runs ON runs(status,created_at);
CREATE TABLE node_runs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),
 input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,
 started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)
);
CREATE TABLE node_attempts (
 id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,
 status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,
 started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)
);
${AGENT_MODEL_SCHEMA}
CREATE TABLE stream_events (
 stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(stream_type,stream_id,sequence)
);
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
 byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE command_receipts (
 scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)
);
CREATE TABLE scripts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 current_draft_version_id TEXT, current_published_version_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE script_versions (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,
 source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
 UNIQUE(script_id,version_no)
);
CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';
CREATE TABLE script_tests (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),
 draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,
 duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)
   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))
);
CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);
CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);
CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts
WHEN NEW.current_draft_version_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;
CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions
WHEN OLD.status='published'
BEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;
PRAGMA application_id = 1331110449;
PRAGMA user_version = ${SCHEMA_VERSION};
`;
