
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
 rebuild_from_id TEXT REFERENCES agent_conversations(id),
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
PRAGMA user_version = 6;

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
 PRAGMA user_version = 8;
CREATE TABLE dictionaries (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),
  current_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(id, kind),
  FOREIGN KEY(id, current_version_id, name, kind)
    REFERENCES dictionary_versions(dictionary_id, id, name, kind)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE dictionary_versions (
  id TEXT NOT NULL PRIMARY KEY,
  dictionary_id TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),
  name TEXT NOT NULL
    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK(length(description) <= 2000),
  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  entries_json TEXT NOT NULL
    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),
  content_hash TEXT NOT NULL
    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  UNIQUE(dictionary_id, version_no),
  UNIQUE(dictionary_id, id),
  UNIQUE(dictionary_id, id, name, kind),
  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)
);
CREATE TABLE run_dictionary_bindings (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  dictionary_id TEXT NOT NULL,
  dictionary_version_id TEXT NOT NULL,
  keys_json TEXT NOT NULL
    CHECK(CASE WHEN json_valid(keys_json)
      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, dictionary_id),
  FOREIGN KEY(dictionary_id, dictionary_version_id)
    REFERENCES dictionary_versions(dictionary_id, id)
);
CREATE INDEX run_dictionary_bindings_by_version
  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);
CREATE TABLE script_test_dictionary_bindings (
  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,
  dictionary_id TEXT NOT NULL,
  dictionary_version_id TEXT NOT NULL,
  keys_json TEXT NOT NULL
    CHECK(CASE WHEN json_valid(keys_json)
      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(test_id, dictionary_id),
  FOREIGN KEY(dictionary_id, dictionary_version_id)
    REFERENCES dictionary_versions(dictionary_id, id)
);
CREATE INDEX script_test_dictionary_bindings_by_version
  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);
CREATE TRIGGER dictionary_versions_no_update
BEFORE UPDATE ON dictionary_versions
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');
END;
CREATE TRIGGER dictionary_versions_no_delete
BEFORE DELETE ON dictionary_versions
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');
END;
CREATE TRIGGER dictionaries_identity_immutable
BEFORE UPDATE OF id, kind ON dictionaries
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');
END;
 PRAGMA user_version = 9;

ALTER TABLE dictionaries ADD COLUMN deleted_at INTEGER
  CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at > 0));
DROP TRIGGER dictionary_versions_no_delete;
CREATE TRIGGER dictionary_versions_no_delete
BEFORE DELETE ON dictionary_versions
WHEN NOT EXISTS (SELECT 1 FROM dictionaries WHERE id=OLD.dictionary_id AND deleted_at IS NOT NULL)
 OR EXISTS (SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)
 OR EXISTS (SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');
END;
PRAGMA user_version = 10;


CREATE TABLE bridge_configuration (
 id TEXT NOT NULL PRIMARY KEY CHECK(id='current'),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 config_json TEXT NOT NULL CHECK(CASE WHEN json_valid(config_json) THEN json_type(config_json)='object' AND length(CAST(config_json AS BLOB))<=16777216 ELSE 0 END),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE agent_workspace_workflow_bindings (
 draft_id TEXT NOT NULL PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
 resource_id TEXT NOT NULL CHECK(typeof(resource_id)='text' AND length(trim(resource_id)) BETWEEN 1 AND 200 AND resource_id GLOB '[a-zA-Z0-9_-]*' AND resource_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE agent_workspace_projection_state (
 id TEXT NOT NULL PRIMARY KEY CHECK(id='maintenance'),
 target_generation INTEGER NOT NULL CHECK(typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991),
 synced_generation INTEGER NOT NULL CHECK(typeof(synced_generation)='integer' AND synced_generation BETWEEN 0 AND 9007199254740991 AND synced_generation<=target_generation),
 target_knowledge_hash TEXT NOT NULL CHECK(length(target_knowledge_hash)=64 AND target_knowledge_hash NOT GLOB '*[^0-9a-f]*'),
 synced_knowledge_hash TEXT CHECK(synced_knowledge_hash IS NULL OR (length(synced_knowledge_hash)=64 AND synced_knowledge_hash NOT GLOB '*[^0-9a-f]*')),
 content_hash TEXT CHECK(content_hash IS NULL OR (length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*')),
 state TEXT NOT NULL CHECK(state IN ('pending','syncing','ready','failed')),
 error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
 CHECK(state!='ready' OR (target_generation=synced_generation AND synced_knowledge_hash IS NOT NULL AND synced_knowledge_hash=target_knowledge_hash AND content_hash IS NOT NULL))
);
CREATE TABLE agent_maintenance_sessions (
 id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),
 actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),
 scenario TEXT NOT NULL CHECK(scenario IN ('workflow','script','web-bridge')),
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('workflow_draft','script_draft','browser_application')),
 owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(trim(owner_id)) BETWEEN 1 AND 200 AND owner_id GLOB '[a-zA-Z0-9_-]*' AND owner_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),
 owner_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(owner_scope_json) THEN json_type(owner_scope_json)='object' AND length(CAST(owner_scope_json AS BLOB))<=65536 ELSE 0 END),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL CHECK(typeof(model_id)='text' AND length(trim(model_id)) BETWEEN 1 AND 500),
 contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),
 tool_policy_version TEXT NOT NULL CHECK(typeof(tool_policy_version)='text' AND length(trim(tool_policy_version)) BETWEEN 1 AND 200),
 knowledge_hash TEXT NOT NULL CHECK(length(knowledge_hash)=64 AND knowledge_hash NOT GLOB '*[^0-9a-f]*'),
 native_ref_json TEXT CHECK(native_ref_json IS NULL OR (CASE WHEN json_valid(native_ref_json) THEN json_type(native_ref_json)='object' AND length(CAST(native_ref_json AS BLOB))<=65536 ELSE 0 END)),
 native_ref_version INTEGER CHECK(native_ref_version IS NULL OR (typeof(native_ref_version)='integer' AND native_ref_version BETWEEN 1 AND 9007199254740991)),
 provider_fingerprint TEXT CHECK(provider_fingerprint IS NULL OR (length(provider_fingerprint)=64 AND provider_fingerprint NOT GLOB '*[^0-9a-f]*')),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleting','deleted')),
 native_delete_state TEXT NOT NULL CHECK(native_delete_state IN ('present','pending','unknown','absent')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
 UNIQUE(id,mode),
 CHECK((scenario='workflow' AND owner_kind='workflow_draft') OR (scenario='script' AND owner_kind='script_draft') OR (scenario='web-bridge' AND owner_kind='browser_application')),
 CHECK((native_ref_json IS NULL AND native_ref_version IS NULL AND provider_fingerprint IS NULL) OR (native_ref_json IS NOT NULL AND native_ref_version IS NOT NULL AND provider_fingerprint IS NOT NULL)),
 CHECK(mode!='single' OR (native_ref_json IS NULL AND native_delete_state='absent')),
 CHECK(native_delete_state!='absent' OR native_ref_json IS NULL),
 CHECK(native_delete_state!='present' OR native_ref_json IS NOT NULL),
 CHECK(lifecycle!='deleted' OR (native_delete_state='absent' AND native_ref_json IS NULL))
);
CREATE TABLE agent_maintenance_tasks (
 id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),
 session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
 projection_generation INTEGER NOT NULL CHECK(typeof(projection_generation)='integer' AND projection_generation BETWEEN 1 AND 9007199254740991),
 projection_hash TEXT NOT NULL CHECK(length(projection_hash)=64 AND projection_hash NOT GLOB '*[^0-9a-f]*'),
 baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),
 status TEXT NOT NULL CHECK(status IN ('queued','running','stopping','succeeded','failed','cancelled','interrupted')),
 process_state TEXT NOT NULL CHECK(process_state IN ('absent','starting','running','stopping','stopped','unknown')),
 input_ref TEXT CHECK(input_ref IS NULL OR (CASE WHEN json_valid(input_ref) THEN json_type(input_ref)='object' AND length(CAST(input_ref AS BLOB))<=65536 ELSE 0 END)),
 display_output_ref TEXT CHECK(display_output_ref IS NULL OR (CASE WHEN json_valid(display_output_ref) THEN json_type(display_output_ref)='object' AND length(CAST(display_output_ref AS BLOB))<=65536 ELSE 0 END)),
 error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 started_at INTEGER CHECK(started_at IS NULL OR (typeof(started_at)='integer' AND started_at BETWEEN 0 AND 9007199254740991)),
 ended_at INTEGER CHECK(ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN 0 AND 9007199254740991)),
 UNIQUE(id,session_id), UNIQUE(session_id,request_id), UNIQUE(session_id,sequence),
 FOREIGN KEY(session_id,mode) REFERENCES agent_maintenance_sessions(id,mode),
 CHECK(mode!='single' OR sequence=1),
 CHECK(status IN ('queued','running','stopping') OR (process_state IN ('absent','stopped') AND ended_at IS NOT NULL))
);
CREATE TABLE agent_maintenance_proposals (
 id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),
 actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),
 session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,
 task_id TEXT NOT NULL,
 submit_request_id TEXT NOT NULL CHECK(typeof(submit_request_id)='text' AND length(trim(submit_request_id)) BETWEEN 1 AND 200),
 submit_request_hash TEXT NOT NULL CHECK(length(submit_request_hash)=64 AND submit_request_hash NOT GLOB '*[^0-9a-f]*'),
 contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow_draft','script_draft','browser_application')),
 target_id TEXT NOT NULL CHECK(typeof(target_id)='text' AND length(trim(target_id)) BETWEEN 1 AND 200 AND target_id GLOB '[a-zA-Z0-9_-]*' AND target_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),
 target_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(target_scope_json) THEN json_type(target_scope_json)='object' AND length(CAST(target_scope_json AS BLOB))<=65536 ELSE 0 END),
 baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),
 body_json TEXT NOT NULL CHECK(CASE WHEN json_valid(body_json) THEN json_type(body_json)='object' AND length(CAST(body_json AS BLOB))<=8388608 ELSE 0 END),
 before_json TEXT NOT NULL CHECK(CASE WHEN json_valid(before_json) THEN json_type(before_json)='object' AND length(CAST(before_json AS BLOB))<=8388608 ELSE 0 END),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
 diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('pending','confirmed','revoked','applied','conflicted','expired')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at>created_at AND expires_at-created_at<=604800000),
 UNIQUE(actor_key,submit_request_id),
 FOREIGN KEY(task_id,session_id) REFERENCES agent_maintenance_tasks(id,session_id) ON DELETE RESTRICT
);
CREATE TABLE agent_maintenance_decisions (
 id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),
 proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE CASCADE,
 actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),
 request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),
 action TEXT NOT NULL CHECK(action IN ('confirm','revoke')),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
 diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 valid_until INTEGER CHECK(valid_until IS NULL OR (typeof(valid_until)='integer' AND valid_until BETWEEN 0 AND 9007199254740991)),
 UNIQUE(id,proposal_id), UNIQUE(actor_key,request_id), UNIQUE(proposal_id,action),
 CHECK((action='confirm' AND valid_until IS NOT NULL AND valid_until>created_at AND valid_until-created_at<=86400000) OR (action='revoke' AND valid_until IS NULL))
);
CREATE TABLE agent_maintenance_apply_requests (
 id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),
 proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE RESTRICT,
 confirmation_id TEXT NOT NULL,
 actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),
 request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('queued','applied','conflicted','rejected')),
 target_generation INTEGER CHECK(target_generation IS NULL OR (typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991)),
 result_json TEXT CHECK(result_json IS NULL OR (CASE WHEN json_valid(result_json) THEN json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536 ELSE 0 END)),
 error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),
 retry_at INTEGER CHECK(retry_at IS NULL OR (typeof(retry_at)='integer' AND retry_at BETWEEN 0 AND 9007199254740991)),
 attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 9007199254740991),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
 settled_at INTEGER CHECK(settled_at IS NULL OR (typeof(settled_at)='integer' AND settled_at BETWEEN 0 AND 9007199254740991)),
 UNIQUE(actor_key,request_id),
 FOREIGN KEY(confirmation_id,proposal_id) REFERENCES agent_maintenance_decisions(id,proposal_id) ON DELETE RESTRICT,
 CHECK((state='queued' AND target_generation IS NULL AND result_json IS NULL AND settled_at IS NULL) OR (state!='queued' AND result_json IS NOT NULL AND settled_at IS NOT NULL)),
 CHECK((state='applied' AND target_generation IS NOT NULL) OR (state!='applied' AND target_generation IS NULL))
);
CREATE INDEX workspace_bindings_resource ON agent_workspace_workflow_bindings(resource_id,draft_id);
CREATE INDEX maintenance_sessions_owner ON agent_maintenance_sessions(actor_key,scenario,owner_kind,owner_id,updated_at,id);
CREATE INDEX maintenance_tasks_session ON agent_maintenance_tasks(session_id,sequence);
CREATE UNIQUE INDEX maintenance_one_project_task ON agent_maintenance_tasks((1)) WHERE status IN ('queued','running','stopping');
CREATE UNIQUE INDEX maintenance_one_session_task ON agent_maintenance_tasks(session_id) WHERE status IN ('queued','running','stopping');
CREATE UNIQUE INDEX maintenance_single_task ON agent_maintenance_tasks(session_id) WHERE mode='single';
CREATE INDEX maintenance_proposals_actor ON agent_maintenance_proposals(actor_key,state,created_at,id);
CREATE INDEX maintenance_proposals_session ON agent_maintenance_proposals(session_id,created_at,id);
CREATE INDEX maintenance_decisions_proposal ON agent_maintenance_decisions(proposal_id,created_at,id);
CREATE INDEX maintenance_apply_queue ON agent_maintenance_apply_requests(state,retry_at,created_at,id) WHERE state='queued';
CREATE UNIQUE INDEX maintenance_one_applied_proposal ON agent_maintenance_apply_requests(proposal_id) WHERE state='applied';


CREATE TRIGGER bridge_configuration_no_replace BEFORE INSERT ON bridge_configuration
WHEN EXISTS(SELECT 1 FROM bridge_configuration WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER agent_workspace_workflow_bindings_no_replace BEFORE INSERT ON agent_workspace_workflow_bindings
WHEN EXISTS(SELECT 1 FROM agent_workspace_workflow_bindings WHERE draft_id=NEW.draft_id)
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER agent_workspace_projection_state_no_replace BEFORE INSERT ON agent_workspace_projection_state
WHEN EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER agent_maintenance_sessions_no_replace BEFORE INSERT ON agent_maintenance_sessions
WHEN EXISTS(SELECT 1 FROM agent_maintenance_sessions WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER agent_maintenance_tasks_no_replace BEFORE INSERT ON agent_maintenance_tasks
WHEN EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE id=NEW.id OR (session_id=NEW.session_id AND (request_id=NEW.request_id OR sequence=NEW.sequence OR (mode='single' AND NEW.mode='single'))) OR (NEW.status IN ('queued','running','stopping') AND status IN ('queued','running','stopping')))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER agent_maintenance_proposals_no_replace BEFORE INSERT ON agent_maintenance_proposals
WHEN EXISTS(SELECT 1 FROM agent_maintenance_proposals WHERE id=NEW.id OR (actor_key=NEW.actor_key AND submit_request_id=NEW.submit_request_id))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER agent_maintenance_decisions_no_replace BEFORE INSERT ON agent_maintenance_decisions
WHEN EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id) OR (proposal_id=NEW.proposal_id AND action=NEW.action))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER agent_maintenance_apply_requests_no_replace BEFORE INSERT ON agent_maintenance_apply_requests
WHEN EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;


CREATE TRIGGER bridge_configuration_revision_monotonic BEFORE UPDATE ON bridge_configuration
WHEN NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_REVISION_MONOTONIC'); END;


CREATE TRIGGER agent_workspace_workflow_bindings_identity_immutable BEFORE UPDATE ON agent_workspace_workflow_bindings
WHEN NEW.draft_id IS NOT OLD.draft_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;


CREATE TRIGGER agent_workspace_projection_state_generation_monotonic BEFORE UPDATE ON agent_workspace_projection_state
WHEN NEW.id IS NOT OLD.id OR NEW.target_generation<OLD.target_generation OR NEW.synced_generation<OLD.synced_generation
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END;


CREATE TRIGGER agent_maintenance_sessions_identity_immutable BEFORE UPDATE ON agent_maintenance_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.scenario IS NOT OLD.scenario OR NEW.owner_kind IS NOT OLD.owner_kind OR NEW.owner_id IS NOT OLD.owner_id OR NEW.owner_scope_json IS NOT OLD.owner_scope_json OR NEW.mode IS NOT OLD.mode OR NEW.provider_id IS NOT OLD.provider_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.tool_policy_version IS NOT OLD.tool_policy_version OR NEW.knowledge_hash IS NOT OLD.knowledge_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;


CREATE TRIGGER agent_maintenance_sessions_generation_monotonic BEFORE UPDATE ON agent_maintenance_sessions
WHEN NEW.generation<OLD.generation OR NEW.revision<OLD.revision
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END;


CREATE TRIGGER agent_maintenance_tasks_identity_immutable BEFORE UPDATE ON agent_maintenance_tasks
WHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.mode IS NOT OLD.mode OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.sequence IS NOT OLD.sequence OR NEW.generation IS NOT OLD.generation OR NEW.projection_generation IS NOT OLD.projection_generation OR NEW.projection_hash IS NOT OLD.projection_hash OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.input_ref IS NOT OLD.input_ref OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;


CREATE TRIGGER agent_maintenance_proposals_content_immutable BEFORE UPDATE ON agent_maintenance_proposals
WHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.session_id IS NOT OLD.session_id OR NEW.task_id IS NOT OLD.task_id OR NEW.submit_request_id IS NOT OLD.submit_request_id OR NEW.submit_request_hash IS NOT OLD.submit_request_hash OR NEW.contract_version IS NOT OLD.contract_version OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_id IS NOT OLD.target_id OR NEW.target_scope_json IS NOT OLD.target_scope_json OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.body_json IS NOT OLD.body_json OR NEW.before_json IS NOT OLD.before_json OR NEW.content_hash IS NOT OLD.content_hash OR NEW.diff_hash IS NOT OLD.diff_hash OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONTENT_IMMUTABLE'); END;


CREATE TRIGGER agent_maintenance_decisions_decision_immutable BEFORE UPDATE ON agent_maintenance_decisions
WHEN 1
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_IMMUTABLE'); END;


CREATE TRIGGER agent_maintenance_apply_requests_identity_immutable BEFORE UPDATE ON agent_maintenance_apply_requests
WHEN NEW.id IS NOT OLD.id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.confirmation_id IS NOT OLD.confirmation_id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;


CREATE TRIGGER agent_maintenance_apply_requests_result_immutable BEFORE UPDATE ON agent_maintenance_apply_requests
WHEN OLD.state!='queued'
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_RESULT_IMMUTABLE'); END;


CREATE TRIGGER maintenance_session_lifecycle BEFORE UPDATE OF lifecycle ON agent_maintenance_sessions
WHEN (OLD.lifecycle='deleted' AND NEW.lifecycle!='deleted')
 OR (OLD.lifecycle='deleting' AND NEW.lifecycle='active')
 OR (NEW.lifecycle!='active' AND EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE session_id=OLD.id AND status IN ('queued','running','stopping')))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_SESSION_BUSY'); END;
CREATE TRIGGER maintenance_session_delete BEFORE DELETE ON agent_maintenance_sessions
WHEN OLD.lifecycle!='deleted' OR OLD.native_delete_state!='absent'
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_DELETE_UNCONFIRMED'); END;
CREATE TRIGGER maintenance_task_admission BEFORE INSERT ON agent_maintenance_tasks
WHEN NEW.status IN ('queued','running','stopping') AND NOT EXISTS(
 SELECT 1 FROM agent_maintenance_sessions s,agent_workspace_projection_state p
 WHERE s.id=NEW.session_id AND s.lifecycle='active' AND s.native_delete_state IN ('present','absent') AND s.generation=NEW.generation
 AND p.id='maintenance' AND p.state='ready' AND p.synced_generation=NEW.projection_generation
 AND p.content_hash=NEW.projection_hash AND p.target_knowledge_hash=s.knowledge_hash)
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_BLOCKED'); END;
CREATE TRIGGER maintenance_task_no_reopen BEFORE UPDATE OF status ON agent_maintenance_tasks
WHEN OLD.status NOT IN ('queued','running','stopping') AND NEW.status IS NOT OLD.status
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_SETTLED'); END;
CREATE TRIGGER maintenance_proposal_owner BEFORE INSERT ON agent_maintenance_proposals
WHEN NEW.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_sessions s JOIN agent_maintenance_tasks t ON t.session_id=s.id
 WHERE s.id=NEW.session_id AND t.id=NEW.task_id AND s.actor_key=NEW.actor_key
 AND s.owner_kind=NEW.target_kind AND s.owner_id=NEW.target_id
 AND s.owner_scope_json=NEW.target_scope_json AND s.contract_version=NEW.contract_version
 AND t.baseline_json=NEW.baseline_json)
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_OWNER'); END;
CREATE TRIGGER maintenance_proposal_state BEFORE UPDATE OF state ON agent_maintenance_proposals
WHEN NEW.state IS NOT OLD.state AND (
 OLD.state NOT IN ('pending','confirmed') OR NEW.state='pending'
 OR (NEW.state='confirmed' AND (OLD.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='confirm') OR EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke')))
 OR (NEW.state='revoked' AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke'))
 OR (NEW.state='applied' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='applied')))
 OR (NEW.state='conflicted' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='conflicted'))))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_STATE'); END;
CREATE TRIGGER maintenance_decision_binding BEFORE INSERT ON agent_maintenance_decisions
WHEN NOT EXISTS(SELECT 1 FROM agent_maintenance_proposals p WHERE p.id=NEW.proposal_id
 AND p.actor_key=NEW.actor_key AND p.content_hash=NEW.content_hash AND p.diff_hash=NEW.diff_hash
 AND NEW.created_at>=p.created_at AND NEW.created_at<p.expires_at
 AND ((NEW.action='confirm' AND p.state='pending' AND NEW.valid_until<=p.expires_at
 AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))
 OR (NEW.action='revoke' AND p.state IN ('pending','confirmed'))))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_BINDING'); END;
CREATE TRIGGER maintenance_apply_confirmation BEFORE INSERT ON agent_maintenance_apply_requests
WHEN NEW.state='applied' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id
 WHERE d.id=NEW.confirmation_id AND d.proposal_id=NEW.proposal_id AND d.action='confirm'
 AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash
 AND (NEW.state!='queued' OR (p.state='confirmed' AND d.valid_until>NEW.created_at AND p.expires_at>NEW.created_at
 AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONFIRMATION_REQUIRED'); END;
CREATE TRIGGER maintenance_apply_commit BEFORE UPDATE OF state ON agent_maintenance_apply_requests
WHEN NEW.state='applied' AND (
 EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping'))
 OR NOT EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id='maintenance' AND target_generation=NEW.target_generation AND state IN ('pending','syncing'))
 OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id
 WHERE d.id=NEW.confirmation_id AND p.id=NEW.proposal_id AND d.action='confirm' AND p.state='confirmed'
 AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash
 AND d.valid_until>NEW.updated_at AND p.expires_at>NEW.updated_at
 AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke')))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_APPLY_BLOCKED'); END;

PRAGMA user_version=11;
