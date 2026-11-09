// Generated from the locked release manifest and historical declarative fixtures. Do not edit.
import type { MigrationDeclaration } from './types.js';
export const currentVersion = 9;
export const sql: Record<number,string> = {
  "1": "\n\nCREATE TABLE runs_v2 (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n);\n\nINSERT INTO runs_v2(id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at)\n SELECT id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at FROM runs;\nDROP TABLE runs;\nALTER TABLE runs_v2 RENAME TO runs;\nCREATE INDEX queued_runs ON runs(status,created_at);\nPRAGMA user_version = 2;\n",
  "2": "\nCREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n )\n);\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status IN ('current','needs_rebuild');\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nALTER TABLE authoring_turns ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);\nALTER TABLE authoring_turns ADD COLUMN backend_turn_id TEXT;\nALTER TABLE authoring_turns ADD COLUMN connection_generation INTEGER;\nALTER TABLE authoring_turns ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'not_sent'\n CHECK(submission_state IN ('not_sent','sending','accepted','settled'));\nALTER TABLE authoring_turns ADD COLUMN input_ref TEXT;\nALTER TABLE authoring_turns ADD COLUMN result_ref TEXT;\nALTER TABLE authoring_messages ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);\nDROP INDEX one_active_turn;\nCREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested');\nCREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);\nCREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);\nPRAGMA user_version = 3;\n",
  "3": "\nCREATE TABLE agent_conversations_v4 (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations_v4(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nINSERT INTO agent_conversations_v4(\n id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,\n transport,connection_fingerprint,cli_version,backend_ref_json,backend_generation,\n synced_revision,rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at)\n SELECT id,draft_id,mode,context_mode,\n   CASE status WHEN 'archived' THEN 'idle' ELSE status END,\n   provider_id,provider_revision,model_id,transport,connection_fingerprint,cli_version,\n   backend_ref_json,backend_generation,synced_revision,rebuild_from_id,\n   NULL,\n   CASE status WHEN 'archived' THEN updated_at ELSE NULL END,\n   created_at,updated_at,last_used_at\n FROM agent_conversations;\nDROP TABLE agent_conversations;\nALTER TABLE agent_conversations_v4 RENAME TO agent_conversations;\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nPRAGMA user_version = 4;\n",
  "4": "\nCREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n);\nCREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n);\nCREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';\nCREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n);\nCREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);\nCREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);\nCREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;\nCREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;\nPRAGMA user_version = 5;\n",
  "5": "\nALTER TABLE script_versions ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000);\nPRAGMA user_version = 6;\n",
  "6": "\nCREATE TABLE agent_conversations_v7 (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations_v7(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nINSERT INTO agent_conversations_v7\n SELECT id,draft_id,mode,\n   CASE mode WHEN 'single' THEN 'isolated' ELSE 'native' END,\n   CASE WHEN transport='legacy' AND mode='multi' AND status!='archived'\n     THEN 'needs_rebuild' ELSE status END,\n   provider_id,provider_revision,model_id,'native',\n   CASE WHEN transport='legacy' THEN '' ELSE connection_fingerprint END,\n   cli_version,\n   CASE WHEN transport='legacy' THEN NULL ELSE backend_ref_json END,\n   backend_generation + CASE WHEN transport='legacy' THEN 1 ELSE 0 END,\n   CASE WHEN transport='legacy' THEN NULL ELSE synced_revision END,\n   rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at\n FROM agent_conversations;\nDROP TABLE agent_conversations;\nALTER TABLE agent_conversations_v7 RENAME TO agent_conversations;\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id) WHERE status='current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nUPDATE provider_settings\n SET config_json=json_set(config_json,'$.transport','native'),\n     revision=revision+1\n WHERE id IN ('codex-cli','pi-cli')\n   AND (json_extract(config_json,'$.transport') IS NULL\n     OR json_extract(config_json,'$.transport')!='native');\nPRAGMA user_version = 7;\n",
  "7": "\nCREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);\nCREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n);\nCREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n);\nCREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);\n PRAGMA user_version = 8;",
  "8": "\nCREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n);\nCREATE TABLE dictionary_versions (\n  id TEXT NOT NULL PRIMARY KEY,\n  dictionary_id TEXT NOT NULL,\n  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),\n  name TEXT NOT NULL\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  description TEXT NOT NULL CHECK(length(description) <= 2000),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  entries_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),\n  content_hash TEXT NOT NULL\n    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL,\n  UNIQUE(dictionary_id, version_no),\n  UNIQUE(dictionary_id, id),\n  UNIQUE(dictionary_id, id, name, kind),\n  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)\n);\nCREATE TABLE run_dictionary_bindings (\n  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(run_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX run_dictionary_bindings_by_version\n  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TABLE script_test_dictionary_bindings (\n  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(test_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX script_test_dictionary_bindings_by_version\n  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TRIGGER dictionary_versions_no_update\nBEFORE UPDATE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionaries_identity_immutable\nBEFORE UPDATE OF id, kind ON dictionaries\nWHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');\nEND;\n PRAGMA user_version = 9;"
};
export const initializationSql = "\nCREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n);\nCREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n);\nCREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;\nCREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END;\nCREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n);\nCREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n);\nCREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nCREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested');\nCREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);\nCREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);\n\nCREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n);\n\nCREATE INDEX queued_runs ON runs(status,created_at);\nCREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n);\nCREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n);\n\nCREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);\nCREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n);\nCREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n);\nCREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);\n\nCREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n);\nCREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n);\nCREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n);\nCREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n);\nCREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n);\nCREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';\nCREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n);\nCREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);\nCREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);\nCREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;\nCREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;\n\nCREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n);\nCREATE TABLE dictionary_versions (\n  id TEXT NOT NULL PRIMARY KEY,\n  dictionary_id TEXT NOT NULL,\n  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),\n  name TEXT NOT NULL\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  description TEXT NOT NULL CHECK(length(description) <= 2000),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  entries_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),\n  content_hash TEXT NOT NULL\n    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL,\n  UNIQUE(dictionary_id, version_no),\n  UNIQUE(dictionary_id, id),\n  UNIQUE(dictionary_id, id, name, kind),\n  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)\n);\nCREATE TABLE run_dictionary_bindings (\n  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(run_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX run_dictionary_bindings_by_version\n  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TABLE script_test_dictionary_bindings (\n  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(test_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX script_test_dictionary_bindings_by_version\n  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TRIGGER dictionary_versions_no_update\nBEFORE UPDATE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionaries_identity_immutable\nBEFORE UPDATE OF id, kind ON dictionaries\nWHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');\nEND;\n\nPRAGMA application_id = 1331110449;\nPRAGMA user_version = 9;\n";
export const baselines: Record<number,{objects: Record<string,unknown>[]}> = {
  "1": {
    "objects": [
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn ON authoring_turns(draft_id) WHERE status='running'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "2": {
    "objects": [
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn ON authoring_turns(draft_id) WHERE status='running'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "3": {
    "objects": [
      {
        "type": "index",
        "name": "conversations_by_draft",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "messages_by_conversation",
        "tbl_name": "authoring_messages",
        "sql": "CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence)"
      },
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested')"
      },
      {
        "type": "index",
        "name": "one_current_conversation",
        "tbl_name": "agent_conversations",
        "sql": "CREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status IN ('current','needs_rebuild')"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "index",
        "name": "turns_by_conversation",
        "tbl_name": "authoring_turns",
        "sql": "CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n )\n)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "4": {
    "objects": [
      {
        "type": "index",
        "name": "conversations_by_activity",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id)"
      },
      {
        "type": "index",
        "name": "conversations_by_draft",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "messages_by_conversation",
        "tbl_name": "authoring_messages",
        "sql": "CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence)"
      },
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested')"
      },
      {
        "type": "index",
        "name": "one_current_conversation",
        "tbl_name": "agent_conversations",
        "sql": "CREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "index",
        "name": "turns_by_conversation",
        "tbl_name": "authoring_turns",
        "sql": "CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "5": {
    "objects": [
      {
        "type": "index",
        "name": "conversations_by_activity",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id)"
      },
      {
        "type": "index",
        "name": "conversations_by_draft",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "messages_by_conversation",
        "tbl_name": "authoring_messages",
        "sql": "CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence)"
      },
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested')"
      },
      {
        "type": "index",
        "name": "one_current_conversation",
        "tbl_name": "agent_conversations",
        "sql": "CREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current'"
      },
      {
        "type": "index",
        "name": "one_script_draft",
        "tbl_name": "script_versions",
        "sql": "CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "index",
        "name": "script_tests_by_script",
        "tbl_name": "script_tests",
        "sql": "CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC)"
      },
      {
        "type": "index",
        "name": "script_versions_by_script",
        "tbl_name": "script_versions",
        "sql": "CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC)"
      },
      {
        "type": "index",
        "name": "turns_by_conversation",
        "tbl_name": "authoring_turns",
        "sql": "CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "script_tests",
        "tbl_name": "script_tests",
        "sql": "CREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "script_versions",
        "tbl_name": "script_versions",
        "sql": "CREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "scripts",
        "tbl_name": "scripts",
        "sql": "CREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_draft_owner_insert",
        "tbl_name": "scripts",
        "sql": "CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_published_version_immutable",
        "tbl_name": "script_versions",
        "sql": "CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "6": {
    "objects": [
      {
        "type": "index",
        "name": "conversations_by_activity",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id)"
      },
      {
        "type": "index",
        "name": "conversations_by_draft",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "messages_by_conversation",
        "tbl_name": "authoring_messages",
        "sql": "CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence)"
      },
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested')"
      },
      {
        "type": "index",
        "name": "one_current_conversation",
        "tbl_name": "agent_conversations",
        "sql": "CREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current'"
      },
      {
        "type": "index",
        "name": "one_script_draft",
        "tbl_name": "script_versions",
        "sql": "CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "index",
        "name": "script_tests_by_script",
        "tbl_name": "script_tests",
        "sql": "CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC)"
      },
      {
        "type": "index",
        "name": "script_versions_by_script",
        "tbl_name": "script_versions",
        "sql": "CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC)"
      },
      {
        "type": "index",
        "name": "turns_by_conversation",
        "tbl_name": "authoring_turns",
        "sql": "CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "script_tests",
        "tbl_name": "script_tests",
        "sql": "CREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "script_versions",
        "tbl_name": "script_versions",
        "sql": "CREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "scripts",
        "tbl_name": "scripts",
        "sql": "CREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_draft_owner_insert",
        "tbl_name": "scripts",
        "sql": "CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_published_version_immutable",
        "tbl_name": "script_versions",
        "sql": "CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "7": {
    "objects": [
      {
        "type": "index",
        "name": "conversations_by_activity",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id)"
      },
      {
        "type": "index",
        "name": "conversations_by_draft",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "messages_by_conversation",
        "tbl_name": "authoring_messages",
        "sql": "CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence)"
      },
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested')"
      },
      {
        "type": "index",
        "name": "one_current_conversation",
        "tbl_name": "agent_conversations",
        "sql": "CREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id) WHERE status='current'"
      },
      {
        "type": "index",
        "name": "one_script_draft",
        "tbl_name": "script_versions",
        "sql": "CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "index",
        "name": "script_tests_by_script",
        "tbl_name": "script_tests",
        "sql": "CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC)"
      },
      {
        "type": "index",
        "name": "script_versions_by_script",
        "tbl_name": "script_versions",
        "sql": "CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC)"
      },
      {
        "type": "index",
        "name": "turns_by_conversation",
        "tbl_name": "authoring_turns",
        "sql": "CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE \"agent_conversations\" (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES \"agent_conversations\"(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "script_tests",
        "tbl_name": "script_tests",
        "sql": "CREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "script_versions",
        "tbl_name": "script_versions",
        "sql": "CREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "scripts",
        "tbl_name": "scripts",
        "sql": "CREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_draft_owner_insert",
        "tbl_name": "scripts",
        "sql": "CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_published_version_immutable",
        "tbl_name": "script_versions",
        "sql": "CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "8": {
    "objects": [
      {
        "type": "index",
        "name": "agent_model_configs_by_provider",
        "tbl_name": "agent_model_configs",
        "sql": "CREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id)"
      },
      {
        "type": "index",
        "name": "conversations_by_activity",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id)"
      },
      {
        "type": "index",
        "name": "conversations_by_draft",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "messages_by_conversation",
        "tbl_name": "authoring_messages",
        "sql": "CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence)"
      },
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested')"
      },
      {
        "type": "index",
        "name": "one_current_conversation",
        "tbl_name": "agent_conversations",
        "sql": "CREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id) WHERE status='current'"
      },
      {
        "type": "index",
        "name": "one_script_draft",
        "tbl_name": "script_versions",
        "sql": "CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "index",
        "name": "run_agent_bindings_by_config",
        "tbl_name": "run_agent_bindings",
        "sql": "CREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision)"
      },
      {
        "type": "index",
        "name": "script_tests_by_script",
        "tbl_name": "script_tests",
        "sql": "CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC)"
      },
      {
        "type": "index",
        "name": "script_versions_by_script",
        "tbl_name": "script_versions",
        "sql": "CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC)"
      },
      {
        "type": "index",
        "name": "turns_by_conversation",
        "tbl_name": "authoring_turns",
        "sql": "CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE \"agent_conversations\" (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES \"agent_conversations\"(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n)"
      },
      {
        "type": "table",
        "name": "agent_model_config_revisions",
        "tbl_name": "agent_model_config_revisions",
        "sql": "CREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n)"
      },
      {
        "type": "table",
        "name": "agent_model_configs",
        "tbl_name": "agent_model_configs",
        "sql": "CREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "run_agent_bindings",
        "tbl_name": "run_agent_bindings",
        "sql": "CREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "script_tests",
        "tbl_name": "script_tests",
        "sql": "CREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "script_versions",
        "tbl_name": "script_versions",
        "sql": "CREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "scripts",
        "tbl_name": "scripts",
        "sql": "CREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_draft_owner_insert",
        "tbl_name": "scripts",
        "sql": "CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_published_version_immutable",
        "tbl_name": "script_versions",
        "sql": "CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  },
  "9": {
    "objects": [
      {
        "type": "index",
        "name": "agent_model_configs_by_provider",
        "tbl_name": "agent_model_configs",
        "sql": "CREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id)"
      },
      {
        "type": "index",
        "name": "conversations_by_activity",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id)"
      },
      {
        "type": "index",
        "name": "conversations_by_draft",
        "tbl_name": "agent_conversations",
        "sql": "CREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "messages_by_conversation",
        "tbl_name": "authoring_messages",
        "sql": "CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence)"
      },
      {
        "type": "index",
        "name": "one_active_turn",
        "tbl_name": "authoring_turns",
        "sql": "CREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested')"
      },
      {
        "type": "index",
        "name": "one_current_conversation",
        "tbl_name": "agent_conversations",
        "sql": "CREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id) WHERE status='current'"
      },
      {
        "type": "index",
        "name": "one_script_draft",
        "tbl_name": "script_versions",
        "sql": "CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft'"
      },
      {
        "type": "index",
        "name": "queued_runs",
        "tbl_name": "runs",
        "sql": "CREATE INDEX queued_runs ON runs(status,created_at)"
      },
      {
        "type": "index",
        "name": "run_agent_bindings_by_config",
        "tbl_name": "run_agent_bindings",
        "sql": "CREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision)"
      },
      {
        "type": "index",
        "name": "run_dictionary_bindings_by_version",
        "tbl_name": "run_dictionary_bindings",
        "sql": "CREATE INDEX run_dictionary_bindings_by_version\n  ON run_dictionary_bindings(dictionary_id, dictionary_version_id)"
      },
      {
        "type": "index",
        "name": "script_test_dictionary_bindings_by_version",
        "tbl_name": "script_test_dictionary_bindings",
        "sql": "CREATE INDEX script_test_dictionary_bindings_by_version\n  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id)"
      },
      {
        "type": "index",
        "name": "script_tests_by_script",
        "tbl_name": "script_tests",
        "sql": "CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC)"
      },
      {
        "type": "index",
        "name": "script_versions_by_script",
        "tbl_name": "script_versions",
        "sql": "CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC)"
      },
      {
        "type": "index",
        "name": "turns_by_conversation",
        "tbl_name": "authoring_turns",
        "sql": "CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE \"agent_conversations\" (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES \"agent_conversations\"(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n)"
      },
      {
        "type": "table",
        "name": "agent_model_config_revisions",
        "tbl_name": "agent_model_config_revisions",
        "sql": "CREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n)"
      },
      {
        "type": "table",
        "name": "agent_model_configs",
        "tbl_name": "agent_model_configs",
        "sql": "CREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "artifacts",
        "tbl_name": "artifacts",
        "sql": "CREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "authoring_messages",
        "tbl_name": "authoring_messages",
        "sql": "CREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "authoring_turns",
        "tbl_name": "authoring_turns",
        "sql": "CREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n)"
      },
      {
        "type": "table",
        "name": "command_receipts",
        "tbl_name": "command_receipts",
        "sql": "CREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n)"
      },
      {
        "type": "table",
        "name": "dictionaries",
        "tbl_name": "dictionaries",
        "sql": "CREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n)"
      },
      {
        "type": "table",
        "name": "dictionary_versions",
        "tbl_name": "dictionary_versions",
        "sql": "CREATE TABLE dictionary_versions (\n  id TEXT NOT NULL PRIMARY KEY,\n  dictionary_id TEXT NOT NULL,\n  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),\n  name TEXT NOT NULL\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  description TEXT NOT NULL CHECK(length(description) <= 2000),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  entries_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),\n  content_hash TEXT NOT NULL\n    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL,\n  UNIQUE(dictionary_id, version_no),\n  UNIQUE(dictionary_id, id),\n  UNIQUE(dictionary_id, id, name, kind),\n  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)\n)"
      },
      {
        "type": "table",
        "name": "drafts",
        "tbl_name": "drafts",
        "sql": "CREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "node_attempts",
        "tbl_name": "node_attempts",
        "sql": "CREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n)"
      },
      {
        "type": "table",
        "name": "node_runs",
        "tbl_name": "node_runs",
        "sql": "CREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n)"
      },
      {
        "type": "table",
        "name": "provider_settings",
        "tbl_name": "provider_settings",
        "sql": "CREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "table",
        "name": "run_agent_bindings",
        "tbl_name": "run_agent_bindings",
        "sql": "CREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n)"
      },
      {
        "type": "table",
        "name": "run_dictionary_bindings",
        "tbl_name": "run_dictionary_bindings",
        "sql": "CREATE TABLE run_dictionary_bindings (\n  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(run_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n)"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n)"
      },
      {
        "type": "table",
        "name": "script_test_dictionary_bindings",
        "tbl_name": "script_test_dictionary_bindings",
        "sql": "CREATE TABLE script_test_dictionary_bindings (\n  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(test_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n)"
      },
      {
        "type": "table",
        "name": "script_tests",
        "tbl_name": "script_tests",
        "sql": "CREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "script_versions",
        "tbl_name": "script_versions",
        "sql": "CREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "scripts",
        "tbl_name": "scripts",
        "sql": "CREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n)"
      },
      {
        "type": "table",
        "name": "stream_events",
        "tbl_name": "stream_events",
        "sql": "CREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n)"
      },
      {
        "type": "table",
        "name": "workflow_versions",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n)"
      },
      {
        "type": "table",
        "name": "workflows",
        "tbl_name": "workflows",
        "sql": "CREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n)"
      },
      {
        "type": "trigger",
        "name": "current_version_owner",
        "tbl_name": "workflows",
        "sql": "CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "dictionaries_identity_immutable",
        "tbl_name": "dictionaries",
        "sql": "CREATE TRIGGER dictionaries_identity_immutable\nBEFORE UPDATE OF id, kind ON dictionaries\nWHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');\nEND"
      },
      {
        "type": "trigger",
        "name": "dictionary_versions_no_delete",
        "tbl_name": "dictionary_versions",
        "sql": "CREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND"
      },
      {
        "type": "trigger",
        "name": "dictionary_versions_no_update",
        "tbl_name": "dictionary_versions",
        "sql": "CREATE TRIGGER dictionary_versions_no_update\nBEFORE UPDATE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND"
      },
      {
        "type": "trigger",
        "name": "script_draft_owner_insert",
        "tbl_name": "scripts",
        "sql": "CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END"
      },
      {
        "type": "trigger",
        "name": "script_published_version_immutable",
        "tbl_name": "script_versions",
        "sql": "CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END"
      },
      {
        "type": "trigger",
        "name": "version_immutable",
        "tbl_name": "workflow_versions",
        "sql": "CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END"
      }
    ]
  }
};
export const declarations: MigrationDeclaration[] = [
  {
    "id": "db.v1-v2",
    "kind": "database",
    "from": 1,
    "to": 2,
    "requires": [],
    "checksum": "0e3af68f093b2db5cffe5b7aadaab5f3db97c9c9ab859ee606d3e69211212567",
    "summary": "重建 runs，支持草稿运行",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "db.v2-v3",
    "kind": "database",
    "from": 2,
    "to": 3,
    "requires": [
      "db.v1-v2"
    ],
    "checksum": "452bda5a3b737b32d2821964722e81b00d2aa21d6798bb9a4f51642472c99510",
    "summary": "新增对话及轮次、消息关联",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "db.v3-v4",
    "kind": "database",
    "from": 3,
    "to": 4,
    "requires": [
      "db.v2-v3"
    ],
    "checksum": "0ffbc2736993e58b7d13772c3203803124672cb3bc59564b2b2e5936036298e6",
    "summary": "历史对话状态与归档信息",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "db.v4-v5",
    "kind": "database",
    "from": 4,
    "to": 5,
    "requires": [
      "db.v3-v4"
    ],
    "checksum": "fa49b41a0172f2d7fbedaa83cf26c5dc30949f7d57625e7fc0724d1b98ed2ae8",
    "summary": "新增脚本库、脚本版本及测试结构",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "db.v5-v6",
    "kind": "database",
    "from": 5,
    "to": 6,
    "requires": [
      "db.v4-v5"
    ],
    "checksum": "29ed4405fc9ed97683f7a3b8dee9b235cd4cd67028a99e164da1b88cf2422649",
    "summary": "版本化脚本执行时限",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "db.v6-v7",
    "kind": "database",
    "from": 6,
    "to": 7,
    "requires": [
      "db.v5-v6"
    ],
    "checksum": "4116c003f2bd70057bb9a3b08f150cdd707bb861cd3c70728a3b0c2e1f1c79a9",
    "summary": "仅保留原生 Agent 会话协议",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "db.v7-v8",
    "kind": "database",
    "from": 7,
    "to": 8,
    "requires": [
      "db.v6-v7"
    ],
    "checksum": "35cc63674bfc2e8b60ad28af0d1589034a464c2b3617460228efaad24361354d",
    "summary": "新增具名 Agent 模型配置、历史修订和运行绑定",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "db.v8-v9",
    "kind": "database",
    "from": 8,
    "to": 9,
    "requires": [
      "db.v7-v8"
    ],
    "checksum": "23efed1d9133d1841790f3224de6a77f96495628439c1802116383ac2ed4d405",
    "summary": "字典、加密字典与运行/测试字典绑定四张表；延迟当前指针外键、版本不可变触发器与对象身份不可变触发器",
    "affectedResources": [
      "workbench.db"
    ],
    "questions": []
  },
  {
    "id": "config.web-bridge.v0-v1",
    "kind": "configuration",
    "from": 0,
    "to": 1,
    "requires": [],
    "checksum": "ae9c0662450c7217866ebf6f70cce232118f2acd44370aff01339a788510242b",
    "summary": "桥接配置增加格式版本并补齐缺失顶层映射",
    "affectedResources": [
      "config/web-bridge.json"
    ],
    "questions": []
  }
];
export const approval = {"status":"approved","reviewer":"用户","date":"2026-11-09","contentDigest":"a9a29eb3bd97386758c0be28012e5cf13b49c7bb44eae3786ed75882af916f58"};
export const releaseDigest = "a6d15b20a8b4c6320cb468d8804118233a4b6f5e5a6bf7d0ae02a03673b50827";
export const manifestChecksum = "f8db736b81d54058f34ed5b7ed580135f50875d3470164ab47025878bffb2e7d";
export const releaseFiles: Record<string,string> = {
  "docs/features/2026-11-06-data-migration/execution-protocol.md": "d19242b2745323f1b2d76a23eab5118a990612d02fb6286ccac802632457f67e",
  "docs/features/2026-11-06-data-migration/release-v6.json": "e3560640299e3d0da4b5c5fa6d15c1a29abd9ad15a976b4cf16467bd6a236b8c",
  "docs/features/2026-11-06-data-migration/schema-approval-v8.json": "598a716d8e7fd04ef5a480254e3f512be5a1095336ddcc9428e3dba8e8c9e604",
  "docs/features/2026-11-06-data-migration/schema-approval.json": "58cbfca6bc7edac4a2a6d3f69d2ccd030241218dbdfc93c05811bc8d845dd099",
  "docs/features/2026-11-06-data-migration/schema-review.md": "d455fb7a86371ceb09b195933c49453db9dee2d7bb932572220aac8c827785b0",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v6.sql": "caa959c5e00a3c70bdd8f5814f28e4c8e7a20697d6c4d74ac14a58d549f2de71",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v8.sql": "d780513fe40fbd1a52dbf349d93ac747b110e64d9fd0e30f2e9882fce0eaf6b8",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v9.sql": "bb6f015ac35ac532174871e9acda0fd7eec504fe0e9836c3984e7da2e0245c34",
  "docs/features/2026-11-06-data-migration/sql/db.v1-v2.sql": "4e9f79c33a3cef4ec6dc51a299fb11d6cf8736ffb511d0e0f1ffe18c99954a87",
  "docs/features/2026-11-06-data-migration/sql/db.v2-v3.sql": "f174b128bb301ce3a9ea683e8d30f085895e44c0fc8f9142f327f3728f1c8abf",
  "docs/features/2026-11-06-data-migration/sql/db.v3-v4.sql": "a79fd6072babbfac4e24067cd9cb386d43a24cc797936a4f5d600e652600db29",
  "docs/features/2026-11-06-data-migration/sql/db.v4-v5.sql": "3f301cb2b9b0cef21ca0cbf4908659571eb31ee41baa673410f6380214ecfca4",
  "docs/features/2026-11-06-data-migration/sql/db.v5-v6.sql": "e14d6b3610dc30364736b0513f0824d7f2a90532c2caadfe67c16af4cff942ed",
  "docs/features/2026-11-06-data-migration/sql/db.v6-v7.sql": "d332b6e9d8db89685066aebb4a0ba0c8532c94ea76c38452a34f4ea280bebfbe",
  "docs/features/2026-11-06-data-migration/sql/db.v7-v8.sql": "8c28338af05c13615e6dccb5c2f69c0536832cb6dccb453018cc31ea4e5bb0ce",
  "docs/features/2026-11-06-data-migration/sql/db.v8-v9.sql": "dbf0019988dad1826bb291091f4750c3afe06273b2b8279d2cb33e3b938f9411",
  "docs/features/2026-11-06-native-only/design.md": "60e670ce9d75d0f1e3e34820566901b224086c6597bf6b313712cefb61c3ca50",
  "docs/features/2026-11-07-agent-model-configs/design.md": "2235775c1108416f87750cead9b713d3d9ecfc7cddab60c80eeb8f5948c803c0",
  "docs/features/2026-11-09-dictionaries/schema-approval-v9.json": "c1993a3c420a0037085497d5f35b452bcd749e1ca5be987ed93321a62b760db3",
  "docs/features/2026-11-09-dictionaries/schema-review-v9.md": "6b874c8b082ec71645ed2bc50a6ede9387f446a7b11c84df0169873b6cd569a9",
  "index.html": "2ccf341b5cae427d99b57d4bdbfb30f4d7bf07983b73ef53f358febaf0444f10",
  "package.json": "6ce7bb951f7ea060d9899defdbd2ac64e4885e7975e99c8857377c15f65dfd68",
  "pnpm-lock.yaml": "167b41ca739ec3292214819d9a62db085b8a9963a88afd6b4bc9a994c8cc643d",
  "scripts/check-migration-manifest.mjs": "f52b3b3a09b9e0ead10a3711948e0cd1c855d5f4f35cc50b6a09134a4e4b5dfb",
  "scripts/create-migration-integrity.mjs": "2cab61886a21ad9fc401c3cbe7825f3c13d67c00ad96c67358f6f94428accd5c",
  "scripts/dev.mjs": "ccb2207256ae2268a157f05f08f9e3f084eeb06515cc11e6c4a1206507cbfe38",
  "scripts/generate-migration-bundle.mjs": "2f5af42776ba024f4525b150f50f2550f9329b47b393fbd8afee2c0916284679",
  "scripts/lock-migration-release.mjs": "acb70a43dafa47d589d6d1a10234003e62b25da417508c2c5f33737022386b04",
  "src/authoring/agent-model-configs.ts": "39e3d482a0077df2534fdc2de62cbba240b1b5b45cd40b313024283fa3d013fa",
  "src/authoring/context.ts": "3e6dc7b30f1c7a05314ef15312f767af820f814601731824e8bbe0f64ed234ae",
  "src/authoring/conversations.ts": "37d025a2cba8dd21ddb8dfa83adc0a7b44245b65c9ea8eb25489828e530822b2",
  "src/authoring/script-agent.ts": "25b69b97a8156006ddea8f3ccc97465a5cfd6f4ba9595fa57a9a1c6fe10401ad",
  "src/authoring/script-library.ts": "09a726048785a320fd92a8923eb217125fceca23498c2008931ecbbfb9fe3312",
  "src/authoring/service.ts": "c9b546a8bc5690c9b4f04a99b2a5f0beedc6170c9e82516a4ec7eeb25247bbe5",
  "src/cli/index.ts": "70d9bc16b7ed63fed0eb48eb3dcdd9a0bf7bc8d98112b9d5792132f650b8e214",
  "src/config-git/cli.ts": "3ac14f6d5124b3fce0c4642cf4065a29f7e098c23a16c47d2406e50687411516",
  "src/config-git/coordinator.ts": "70e2c943d81ea78971ee1505fa0b4bb72218bc74491ed884c5694ad53e46e6ac",
  "src/config-git/operations.ts": "63340513d6b9ff31356fc93e6743ce3fbcfb256882967c1e587663f4670ab098",
  "src/config-git/repository.ts": "da9b669398830961b6db988b578a39a33ee0d14d3be96a7e5f02b19e5dc10f02",
  "src/config-git/restore-files.ts": "48cf1ed79339e6ef5d70b14207c6f08d575c6f1060d2f1c48fc23b16124b1d1f",
  "src/config-git/restore-import.ts": "ae1237669bb7eeb21427c1dd4b37b7c19a2cc0dd6c7ede82b9ac984f14613f3c",
  "src/config-git/restore.ts": "24bf7af584f5bc124e81646e528f1e328349aebef84b67b7d8573909eadb7259",
  "src/config-git/routes.ts": "6d6af0f161e3e50b537b10802f43df6e3a8c17aa3ebccdec6b7f5a7e98fdb0de",
  "src/config-git/service.ts": "3ed5bc61241c11856775965c5946eef7f022f2c61725884a4948c884ed401e88",
  "src/config-git/snapshot-primitives.ts": "17f52d9a786a927d19b28fa60cd6de8e69e8e1f38182b4107dca0758fc30ccbb",
  "src/config-git/snapshot-types.ts": "1f3e167c522f35bf4a803c4cc40e87aa623b6607f2cdbe9d699935ea6f36f262",
  "src/config-git/snapshot-validation.ts": "db029cef3d2554b09cbd2f45ec14f739d7d37495b383e31fa14e2d992118cafb",
  "src/config-git/snapshot.ts": "279a55a95dabd6fbc4218a4b64690f28305b3763d52a465ab1b432e4241dfb74",
  "src/dictionaries/canonical.ts": "68026a2ccf6415c92a969f16a66aae9f34b6a35e6d2432a04870554ede5a7fd7",
  "src/dictionaries/model.ts": "028fe51dc1e0af00cce5af45fddf992f74643d9677a84f4c6b7533c2eb88531f",
  "src/dictionaries/routes.ts": "1e99e3270de58ebba7a09c2883488c431f0ddd91f5c220aa3fe39246d6c3719e",
  "src/dictionaries/service.ts": "8d409462a037369d3ebd724a71a933effce423a46f0b578178201e320541519c",
  "src/domain/errors.ts": "bc2c4950e109eba16caf62231c321c61f4689c9d54c0e0b4e81a8aaeffa5c7a1",
  "src/domain/models.ts": "3947f43c3212d2770471f008a809d5c79ea99362fd6c1c8169ac74adab855b4e",
  "src/domain/schema-compatibility.ts": "7de77ef2b60b648f501b0ee679488cda439e60f674e2ce32a93938e0e2a39ae2",
  "src/domain/script-authoring.ts": "34717a03edc3affebbaa3ee560828a26afc7d3f273a93c32916f6cc1a7e3858d",
  "src/domain/scripts.ts": "6ff0e060d3b14ea253f7ef1cab540c864b5a2fcff10c485658a47488097462cc",
  "src/domain/turns.ts": "8bc48474c8084d4231c833ac5377a5148649d3480d515e3632c3b987aecf4488",
  "src/domain/types.ts": "419b4c5688d9926dc4fe0ba1d0e6524b2ca56e48923a427ab3f9a27a1f8dcbda",
  "src/domain/validation.ts": "510d8dc2c187575b337db920efc2de6fb6044ae6e5e4e78b84ce38f09fdc6368",
  "src/migrations/config.ts": "7f4c89873da967575f1e96f7099eb81fc8288479014a6d5ef78d3799b03459f3",
  "src/migrations/definitions.ts": "6a46dcc41808b4b61578f7b70e05de9ca037d7c9357b9845991a7ae31d2ead3d",
  "src/migrations/journal.ts": "cfa41b539c32b6b4c39ee8d60394194c9ace4ffb88d5511c326442e463bc606b",
  "src/migrations/lock.ts": "63f6818b13aee27350e6961dbd6efbf52924477f0c37834aedbd516035b04ac5",
  "src/migrations/mapping.ts": "6d741a59d75c396957258803c08eb12d70db1da7023a4e11cc17d27c77dcf7fc",
  "src/migrations/planner.ts": "a6ce89781fcd0b85d6edc9482dacbedc1843db2bf6b60f634ad03f7b909038ae",
  "src/migrations/preview.ts": "31d2a0da0cb3e3df17ab46e1eef8a197b137fb35ec0d5dcfbb4d91f78387b2e4",
  "src/migrations/questions.ts": "d2981be8ecd70f69b140f783c2db8fe9af46b7805e3d55fe2dd8d74ac4abc040",
  "src/migrations/release.ts": "c86fcd1bdafb2ab0c96131a84774e7ffef10f3fe6b4d2eddafa5ad981411cc5a",
  "src/migrations/runner.ts": "961d0e4b6acc49aa2cdff021becb3dbbb247986c420a31941382c1235174fe3c",
  "src/migrations/types.ts": "32794b6a450416bfa508ac085a3eb9afc8f393e37d1dacbf59767703090e13cc",
  "src/migrations/validators.ts": "611ea7c0caef4dae3a98d9c67fe9f4f488567d99bb78c48693af75b538b58354",
  "src/migrations/worker.ts": "abbb9442390c4d4184a134c43e4967551273c2a27f2b228e6f812c986de6ce65",
  "src/persistence/files.ts": "c17a26cceaa7a2aabcda95c20b5fad5eb082213f6afe3bc7aacf513c87b537f3",
  "src/persistence/schema.ts": "6ffee6c12ccc90ff6b2db02abf120e41aae808689e5d1fc9faddc6bf22affe87",
  "src/persistence/script-journal.ts": "2ae2e6dbe3b9837e3ada1df0fbdb8525c46fb44361b7613b04def9ff9bb95ae2",
  "src/persistence/script-maintenance.ts": "9b57195afa356ffc6963c1398295c4512e59e5fa350e289afc8a74be532a00d6",
  "src/persistence/store.ts": "9ea794b175f531e80acfc2294d5e294c74d7a9201f279b94cadf053e2f03386f",
  "src/providers/agent-limits.ts": "c3a26de962c275a34b902d61c0ee999158833624a337bcdf8686b5d61fe4ed35",
  "src/providers/codex-app-server.ts": "9f0cb6fee2f30bae6949f2f657eb6696ca783eddf1e76990e1476862137e2719",
  "src/providers/codex-config.ts": "0172aee1c55490b99dcb1c9754fd37f0c903687e796ea1d0626af954337dd9e6",
  "src/providers/pi-rpc.ts": "8627c902827291ed06f9b8c72ad80c2e5eecc0e78f1cde0f156a12166dadf02a",
  "src/providers/registry.ts": "1cd7a3519423914c1383eceb08544166843650e5d7baa921cb0ca1faa285849b",
  "src/providers/session-manager.ts": "5a756ac856fd62e6c839ec339f1281fbb32aac5c25792b9a5bef8ec6f6fd6c27",
  "src/providers/session.ts": "ce7f7c6cfa7da50ddc859cf80390b7e35ecebab8becaacf2c77054c982daeebe",
  "src/providers/transport/jsonl.ts": "d2f544b19ab0b2bf0bb723a2d7ff7c9b0c0e0ba3d8328d6c48b375e3516167f3",
  "src/providers/transport/pending.ts": "c9eecf152a5952ef97e9bbd1ba3179d0aaf5f83222e3a248c836da7164acac28",
  "src/runtime/process.ts": "49845e3313352c3cc55900bb4b8e82a61767e63724f40101eeeacc15242fbdef",
  "src/runtime/runner.ts": "14a7cc9efe1b63884ce24dc96119b5436f22bf42f6cbb02da82a8876e70eb617",
  "src/runtime/script-tests.ts": "2e3ac8efd05143b06903fccc681b51e08a61dc684e47f182a49b0028ba53b8cc",
  "src/runtime/script.ts": "8a92490ccb356ae3b54aa1247fa6bad9fdd1d23bfed4069af63dabbd05f86ecd",
  "src/secrets/aead.ts": "668fa9e6545aa226763d07f25514880c5220680938fd9cd7e41703fe7c997334",
  "src/secrets/backup.ts": "a0da9bab7bf287cc638a7ba26a11e68569f1fcaaeb0187d20cdabce554a73f42",
  "src/secrets/cli.ts": "943610612aa15b8a8dacb6e71f92d5761cf48abdd3407de5a3ce3b9e6b8f422c",
  "src/secrets/command-hmac.ts": "e10af88570a7633142d681320ba6bc99670d681f2513dd3265ea6ee973bd31fd",
  "src/secrets/files.ts": "c02eff05e293e84effa9dd24f5ba22cd4de0b76802f30a13a10b6acd9cb1ff27",
  "src/secrets/keyring.ts": "8e3661877d4c81176bfce2e8472bab5a4f61d80f329799e4534f3c2fc4a27f57",
  "src/secrets/keys.ts": "d86f60a3ac96288f3da5fe3da86450c2038185de6c018da8f52c52ff8dfba088",
  "src/secrets/service.ts": "09802ccab79a40b72903c3ff438662ccc64b6431db1321fabab22a77cef745bf",
  "src/server/app.ts": "01c79fb16453feafd8f0bb6116e701943f7097fad312fb8a58b66166faa8455d",
  "src/server/bootstrap.ts": "c2cdd946568471e9b57665d35ba2ea69be51182df86bbe9b90d33193a4a595e3",
  "src/server/main.ts": "84c41c3734ec8b4c4344117636fa2b97babc780bfd4558107a2c9ee17d1a82a1",
  "src/web-bridge/agent.ts": "2b5861b86208484059abcbdd39f864de0abc3d0d212e176c693a01866e7e967c",
  "src/web-bridge/auth.ts": "489a36654e1aa0e88e8905b51082392107845b99b9a2deb6cb80c68789d2323b",
  "src/web-bridge/authoring.ts": "0fe2e684f0d0f8c56b59881e1a8e858b9ffef2bea46b283b9066051d99fce70b",
  "src/web-bridge/catalog.json": "37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570",
  "src/web-bridge/catalog.ts": "f5ee421852a67f37f578570c6eb30a5766e4be30213fcd37cdf87a681fc515b7",
  "src/web-bridge/client.ts": "8650628ecfda5f27a7b5cd7d1d3bc5f4149cd4d2ef373814ce9d7b5e0e31d974",
  "src/web-bridge/config.ts": "f0d6ae1f807f07670b92598c99d279d402707663c8ce9790261de3f493faef9b",
  "src/web-bridge/extension/background.js": "1ff894e65501e591827290e2c70f931ec8b629cbae255209bd884b5b08f172a5",
  "src/web-bridge/extension/manifest.json": "51f4bae191ea6cf26f98df0a25c9a04f192cd37949f1c1c872be03060bb3f2d9",
  "src/web-bridge/extension/popup.css": "cf98579b7fab8b1f1e60993a655707e2b0b9fe60404afe98db9c07f66e5c1740",
  "src/web-bridge/extension/popup.html": "94e1ef70aefb696c7a2858937536d1bacde3f9ecdb7823540a5f0f5564309a8b",
  "src/web-bridge/extension/popup.js": "e9a6bb18967ace04a676b2317d60587fa67e53fa29d1500c1ad1a2af5df2127f",
  "src/web-bridge/gateway.ts": "1d4f347f9c39126dc578e3228b0db5fc008ed1608157a51c73c8223c707ca76c",
  "src/web-bridge/install.ts": "6fd0ff1f2dc9d69bf42229ce19781d816a8995071beb60f60252c4594bf11e5c",
  "src/web-bridge/protocol.ts": "ec5d5cbae800b245075fe18cc26d4bcac43f2b4ddb1c0775a694478e1cdce0db",
  "src/web/App.tsx": "d3033921ce9f32bad27c242566063e15f6b962c4c3f936234a090fe8822d8761",
  "src/web/Bootstrap.tsx": "5961b1f8c343748d0fba5dc55dd13af7fbf17c97927d70adf593e4f069fcddcb",
  "src/web/agent-chat/AgentChat.tsx": "ed922221aeb9ab92b1d0432bb6981b59ad2adb32482be9a927f79f7a01b1fa19",
  "src/web/agent-chat/ChatHistory.tsx": "2439453d76a9862267e6179ceb10e930ca1b85a73057c766603ec23a497fc5c6",
  "src/web/agent-chat/adapters/browser-application.tsx": "a0ec11ae508b8d48f067f9b2794a9563d4502cf69c9f66eec37050a981345d03",
  "src/web/agent-chat/adapters/script.tsx": "b26932fcf476493c6ae5d31e8658f70f5a84616ea8165bc39c5c317ea2db4468",
  "src/web/agent-chat/adapters/workflow.tsx": "891b25742edf2d3b011d6164e3b548e264288844e7179d87e2b33d25b8afd8f2",
  "src/web/agent-chat/agent-chat.css": "54378db541d0d865684a7df8afde129b705d9c6e41908ae3a30f737da0018843",
  "src/web/agent-chat/types.ts": "3a7484acb3f5e73ab8163a8fdda623942322872919acd423b56146aecff07bcd",
  "src/web/agent-chat/useAgentChat.ts": "c8c46cc7b45ee16ad2f97fdac1be5520cb91ebd944a6464f1639ae3bc271f074",
  "src/web/agent-chat/useChatPolling.ts": "282dd642d042f11248d1804b1255909b692bf5bc2de474887ab6a4c1bb390206",
  "src/web/components/AppSidebar.tsx": "3fcd2b767f0b59d5b4fae889dc3afc4031db039c5234a95500e7e990bc4ddefc",
  "src/web/components/common.tsx": "e300783b609a84f5037989d5e6359ded1a230dca22e3aa9774bc138f61b9de0f",
  "src/web/components/ui/badge.tsx": "0311bb21a5dc8c1e3d70ffc35cccc375c90e2f08bb0f0dd943dad72c19ed45ff",
  "src/web/components/ui/button.tsx": "557e27d5d3159c338da761c5aec138dcd32d313b5a55774ea8001c3f3bfc620c",
  "src/web/components/ui/dialog.tsx": "0a85c31675f8269b3b1308fff0ab10d5cda1a090a550a1a74a8f7f439a92ea06",
  "src/web/components/ui/input.tsx": "7bfd0eff6c53a38c99184394a09f55e7a86c725de12d6a300fa46b3765114091",
  "src/web/components/ui/select.tsx": "6d3a0333c0f2dd5bd4ffc4e1a68369d8cb29bed161b3cdd3410a9a1274e0b991",
  "src/web/components/ui/separator.tsx": "f9ec8dde26a5c3f2af1c48a0c588c164e350567cddc5c4070cf5ba780e984f26",
  "src/web/components/ui/tabs.tsx": "3cb17f78388aa753d544b24237f8f90253bb2f4b5beeeaf7a948b28e61fe3902",
  "src/web/components/ui/textarea.tsx": "7c7122fc969c62228c691388aa1fe8b1eafe787ac25305a7a768f77d87d3c567",
  "src/web/features/AgentModelConfigPicker.tsx": "179fba5e7f50dd954b2e02c8f6dd66a3f17b20db5e0350b75465bb4b2313d4e6",
  "src/web/features/AgentModelConfigSettings.tsx": "f4ce83c71fbe27e1420bdeb06814ec41632330b7d3c3582be451b35321b04cd0",
  "src/web/features/ArchiveConversationButton.tsx": "a8b0b293239a779f183d1e45273c0b5aaf445076c10c2495945a088d8d482d63",
  "src/web/features/BridgeAgentPanel.tsx": "75b336d667e1b504e341142de436a394ad6a2abe724f2066c005e27ae86b8443",
  "src/web/features/BridgeToolForm.tsx": "b6a3d032b8050d967d76e9dd742397c0abf8f153c4be42a31b88374fb8c4f754",
  "src/web/features/CodeEditor.tsx": "b0c3d7540dff188ca183a32e0a6c004b65bb1b10cfcc078ec8cf7ece7dbefc8b",
  "src/web/features/ConfigGitSettings.tsx": "10bbafc2dfbc4553b44608f524000523bd4448215fedb43e272774ce01da6583",
  "src/web/features/ConversationDrawer.tsx": "f5f777bd31e45f39ff0b4f405386793197bfcbda0d4e72d87cb66c6b59a0fe2a",
  "src/web/features/DeleteWorkflowButton.tsx": "c98b76855e29881c92dae1ee5560ed66accc55978265c455516e69be388efeff",
  "src/web/features/DictionariesPage.tsx": "8f98359df4d61d92fe0949e9f3102804b7deadb2766fc8478cd4f8226e5e380d",
  "src/web/features/DraftPage.tsx": "0393cb2284084fd4e88306ac5b9981ce1c4a207e0adb1f8244619f4335faa3d1",
  "src/web/features/FinalResult.tsx": "42052a40a27bd4317a8e686d766ad87c1536cf0a1e1f0113e3af8ae600f9c016",
  "src/web/features/FlowCanvas.tsx": "e359cbad66510fc8f6d8d4d8e14d13adadb288e44fe80a806318a2cd77f23e8c",
  "src/web/features/ModelManager.tsx": "f2505877726b3fbfba0f128604e67e6913a33ce6728313ac69fdcf9e27ed3bf4",
  "src/web/features/ProviderPicker.tsx": "97ce1eaf3364e9a553ef4934e864d88b237ca61ed5054f49304e62df9657cab1",
  "src/web/features/RunPages.tsx": "c6c754677348cdd0f68636f99db4adcf758e855c28ce120796eb789db4d514d0",
  "src/web/features/ScriptAgentPanel.tsx": "a3d549655dddd919ef75f60d5fc995d332abf46217ab9f8f03e34ee3546a7b70",
  "src/web/features/ScriptAgentPreview.tsx": "eef83011164187f69e90293a03d64191509a73e24793a85d6babf32655ac71b9",
  "src/web/features/ScriptNodePicker.tsx": "c34fefc91fcb277c4fabb4e7bb31a61841228c43e40abcd65d4850840e7ec97b",
  "src/web/features/ScriptPages.tsx": "35596db486fc6dc5f7f8c690ebd1a7ba3ff473847ccdd131c209e87fb6e0297d",
  "src/web/features/ScriptVersionPanels.tsx": "b0cc5a87283dc29a5d222935450b5ee20335cf7fc433093ebc67f93ac6fd16d6",
  "src/web/features/SecretKeySettings.tsx": "be6fd93887bb26823287609de3f6e85e3cc4b136db7e300abb0c51d7f58e061c",
  "src/web/features/SettingsPage.tsx": "1a24eead82803a856ce9abc3ed8ad73e2c0fb4597bd7d9b6288bd170f4b24cb9",
  "src/web/features/SourceTabs.tsx": "e777d5d1045395bf34860a78ef6f455d36f557ea0de01762ac64db7bec7bec48",
  "src/web/features/WebBridgeSettings.tsx": "6678139ec94c4d997a2f63209a711525dc511d2d8c585bf5eae1021d42df7662",
  "src/web/features/WorkflowOutputEditor.tsx": "b287b056c8cee2cdfdea1acc8a71d73b8f1d74307d86970398c5fd79b73c69f5",
  "src/web/features/WorkflowPages.tsx": "4b42cc94ff3febb9a1111e0247a1513de5e577067ab7ae6e06198be96b595cf0",
  "src/web/features/dictionaries.css": "78cc36781324148e286ac6a04c94074559b83423ef99771f319fab11889027d8",
  "src/web/features/graph.ts": "071d4031e27e20615a79e80297fd0e6104a61c8e0b3027e3f91f6b8b9281b91f",
  "src/web/lib/api.ts": "a32d7c301999a764ed5511e3af905cf4908273b06a3395876ce7e029248e5c3c",
  "src/web/lib/editor-theme.ts": "ea2f3577454be160560259b32b362a91a88085ba99e33f8838098b42c5710acc",
  "src/web/lib/theme.tsx": "a91ba0a903ebdd3f20fcd6a98074fa7dd10b7d2d54624192fbabe135232c08d5",
  "src/web/lib/utils.ts": "64fc84c1be627f0d586fb4ba64d824a1604f44282381f5bae68cdf86e10bb6ec",
  "src/web/main.tsx": "68e366be3f173f2bbce63b6d300cbd2a1395dd4eb1194a805ebda2a220a0beec",
  "src/web/styles.css": "1118833cf1cd464065809cbd6be23550757eefc3b5bf845cdafb88008334881c",
  "tests/fixtures/migrations/config/v0-empty.json": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
  "tests/fixtures/migrations/config/v0-full.json": "c8ad3a6baf7f06bb1b403a9fefd738cbf3e9b3f74168c52762ed61abbcfadd0c",
  "tests/fixtures/migrations/config/v0-partial.json": "20401c22a2303b77d0d99d15acd00a6f824659295db2556df5bbc16351d90f38",
  "tests/fixtures/migrations/config/v1-full.json": "008abcd9e07602a8be426ace85532f1e0fb280a7817825a9acdf53c1f370f9c6",
  "tests/fixtures/migrations/database/provenance.json": "5cd4d9e38c9f45026d11c96da710961b157c22f5d3f8a7434cc4fac53fa8f1ec",
  "tests/fixtures/migrations/database/v1.sql": "3fb10171ffa8f3331bd944e141f20cda01088f944debee353cedc5e49e4dab09",
  "tests/fixtures/migrations/database/v2.sql": "af50487c0ffc1b937a0aa71bcb59431878e0f93cc936bae1441037fc9b10cb97",
  "tests/fixtures/migrations/database/v3.sql": "b605ab49bb22d4e32ef626bd9f9b2b21fe8a2a641517dcd62cb5fe270e082b69",
  "tests/fixtures/migrations/database/v4.sql": "6b7422952ffb9dcee55c5dccfbf55b7c501f937cfb721f4717a2720638282c0b",
  "tests/fixtures/migrations/database/v5.sql": "5651235896df557f2009050a2a7da68b0a79860cf3168c0333c72215ce8c115f",
  "tests/fixtures/migrations/database/v6.sql": "caa959c5e00a3c70bdd8f5814f28e4c8e7a20697d6c4d74ac14a58d549f2de71",
  "tests/fixtures/migrations/database/v7.sql": "b89838a23570f4903cc4a53e3d80bbf6f1859aa3abd6f61964a1305b782b4c4e",
  "tests/fixtures/migrations/database/v8.sql": "54b14f54b6b2689fcca83613babcfe264e3f27ab2f424e60cb749b0524d75c08",
  "tests/fixtures/migrations/database/v9.sql": "98ccae487909e0baee7f71770c17fdeffcbc790f8cc59cadc0dee299862109cd",
  "tests/fixtures/migrations/kill-runner.ts": "3dbd40050112bae5ea05fda33d02568432e62b77aeff8cb63b2286fdfc34262b",
  "tests/fixtures/migrations/lock-runner.ts": "d491968ef2323be70e3eabb282981e5199e699b5ede5df52eef21d7c995960d5",
  "tests/fixtures/migrations/question-migration.ts": "62bfc59a5903969f9fcbd9933adef2d01770d27f860e74e2b1e80f05876e142f",
  "tsconfig.json": "9787405896191365078dd19e661a7ff69e1678cb29b105a04f5a8581d5d66301",
  "tsconfig.server.json": "df836bd3c87612646f1563670a6e52d9dd00a7619a711818e758524397c56eb5",
  "vite.config.ts": "8fd36b5909b6236e56c3b141421280411150532c04e3969e9647fcb65f4541d7"
};
