// Generated from the locked release manifest and historical declarative fixtures. Do not edit.
import type { MigrationDeclaration } from './types.js';
export const currentVersion = 10;
export const sql: Record<number,string> = {
  "1": "\n\nCREATE TABLE runs_v2 (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n);\n\nINSERT INTO runs_v2(id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at)\n SELECT id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at FROM runs;\nDROP TABLE runs;\nALTER TABLE runs_v2 RENAME TO runs;\nCREATE INDEX queued_runs ON runs(status,created_at);\nPRAGMA user_version = 2;\n",
  "2": "\nCREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n )\n);\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status IN ('current','needs_rebuild');\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nALTER TABLE authoring_turns ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);\nALTER TABLE authoring_turns ADD COLUMN backend_turn_id TEXT;\nALTER TABLE authoring_turns ADD COLUMN connection_generation INTEGER;\nALTER TABLE authoring_turns ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'not_sent'\n CHECK(submission_state IN ('not_sent','sending','accepted','settled'));\nALTER TABLE authoring_turns ADD COLUMN input_ref TEXT;\nALTER TABLE authoring_turns ADD COLUMN result_ref TEXT;\nALTER TABLE authoring_messages ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);\nDROP INDEX one_active_turn;\nCREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested');\nCREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);\nCREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);\nPRAGMA user_version = 3;\n",
  "3": "\nCREATE TABLE agent_conversations_v4 (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations_v4(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nINSERT INTO agent_conversations_v4(\n id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,\n transport,connection_fingerprint,cli_version,backend_ref_json,backend_generation,\n synced_revision,rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at)\n SELECT id,draft_id,mode,context_mode,\n   CASE status WHEN 'archived' THEN 'idle' ELSE status END,\n   provider_id,provider_revision,model_id,transport,connection_fingerprint,cli_version,\n   backend_ref_json,backend_generation,synced_revision,rebuild_from_id,\n   NULL,\n   CASE status WHEN 'archived' THEN updated_at ELSE NULL END,\n   created_at,updated_at,last_used_at\n FROM agent_conversations;\nDROP TABLE agent_conversations;\nALTER TABLE agent_conversations_v4 RENAME TO agent_conversations;\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nPRAGMA user_version = 4;\n",
  "4": "\nCREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n);\nCREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n);\nCREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';\nCREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n);\nCREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);\nCREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);\nCREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;\nCREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;\nPRAGMA user_version = 5;\n",
  "5": "\nALTER TABLE script_versions ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000);\nPRAGMA user_version = 6;\n",
  "6": "\nCREATE TABLE agent_conversations_v7 (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations_v7(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nINSERT INTO agent_conversations_v7\n SELECT id,draft_id,mode,\n   CASE mode WHEN 'single' THEN 'isolated' ELSE 'native' END,\n   CASE WHEN transport='legacy' AND mode='multi' AND status!='archived'\n     THEN 'needs_rebuild' ELSE status END,\n   provider_id,provider_revision,model_id,'native',\n   CASE WHEN transport='legacy' THEN '' ELSE connection_fingerprint END,\n   cli_version,\n   CASE WHEN transport='legacy' THEN NULL ELSE backend_ref_json END,\n   backend_generation + CASE WHEN transport='legacy' THEN 1 ELSE 0 END,\n   CASE WHEN transport='legacy' THEN NULL ELSE synced_revision END,\n   rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at\n FROM agent_conversations;\nDROP TABLE agent_conversations;\nALTER TABLE agent_conversations_v7 RENAME TO agent_conversations;\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id) WHERE status='current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nUPDATE provider_settings\n SET config_json=json_set(config_json,'$.transport','native'),\n     revision=revision+1\n WHERE id IN ('codex-cli','pi-cli')\n   AND (json_extract(config_json,'$.transport') IS NULL\n     OR json_extract(config_json,'$.transport')!='native');\nPRAGMA user_version = 7;\n",
  "7": "\nCREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);\nCREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n);\nCREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n);\nCREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);\n PRAGMA user_version = 8;",
  "8": "\nCREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n);\nCREATE TABLE dictionary_versions (\n  id TEXT NOT NULL PRIMARY KEY,\n  dictionary_id TEXT NOT NULL,\n  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),\n  name TEXT NOT NULL\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  description TEXT NOT NULL CHECK(length(description) <= 2000),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  entries_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),\n  content_hash TEXT NOT NULL\n    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL,\n  UNIQUE(dictionary_id, version_no),\n  UNIQUE(dictionary_id, id),\n  UNIQUE(dictionary_id, id, name, kind),\n  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)\n);\nCREATE TABLE run_dictionary_bindings (\n  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(run_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX run_dictionary_bindings_by_version\n  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TABLE script_test_dictionary_bindings (\n  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(test_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX script_test_dictionary_bindings_by_version\n  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TRIGGER dictionary_versions_no_update\nBEFORE UPDATE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionaries_identity_immutable\nBEFORE UPDATE OF id, kind ON dictionaries\nWHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');\nEND;\n PRAGMA user_version = 9;",
  "9": "\nALTER TABLE dictionaries ADD COLUMN deleted_at INTEGER\n  CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at > 0));\nDROP TRIGGER dictionary_versions_no_delete;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nWHEN NOT EXISTS (SELECT 1 FROM dictionaries WHERE id=OLD.dictionary_id AND deleted_at IS NOT NULL)\n OR EXISTS (SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\n OR EXISTS (SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nPRAGMA user_version = 10;\n"
};
export const initializationSql = "\nCREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n);\nCREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n);\nCREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;\nCREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END;\nCREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n);\nCREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n);\nCREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nCREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested');\nCREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);\nCREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);\n\nCREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n);\n\nCREATE INDEX queued_runs ON runs(status,created_at);\nCREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n);\nCREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n);\n\nCREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);\nCREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n);\nCREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n);\nCREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);\n\nCREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n);\nCREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n);\nCREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n);\nCREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n);\nCREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n);\nCREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';\nCREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n);\nCREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);\nCREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);\nCREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;\nCREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;\n\nCREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n);\nCREATE TABLE dictionary_versions (\n  id TEXT NOT NULL PRIMARY KEY,\n  dictionary_id TEXT NOT NULL,\n  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),\n  name TEXT NOT NULL\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  description TEXT NOT NULL CHECK(length(description) <= 2000),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  entries_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),\n  content_hash TEXT NOT NULL\n    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL,\n  UNIQUE(dictionary_id, version_no),\n  UNIQUE(dictionary_id, id),\n  UNIQUE(dictionary_id, id, name, kind),\n  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)\n);\nCREATE TABLE run_dictionary_bindings (\n  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(run_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX run_dictionary_bindings_by_version\n  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TABLE script_test_dictionary_bindings (\n  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(test_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX script_test_dictionary_bindings_by_version\n  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TRIGGER dictionary_versions_no_update\nBEFORE UPDATE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionaries_identity_immutable\nBEFORE UPDATE OF id, kind ON dictionaries\nWHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');\nEND;\n\n\nALTER TABLE dictionaries ADD COLUMN deleted_at INTEGER\n  CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at > 0));\nDROP TRIGGER dictionary_versions_no_delete;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nWHEN NOT EXISTS (SELECT 1 FROM dictionaries WHERE id=OLD.dictionary_id AND deleted_at IS NOT NULL)\n OR EXISTS (SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\n OR EXISTS (SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nPRAGMA user_version = 10;\n\nPRAGMA application_id = 1331110449;\nPRAGMA user_version = 10;\n";
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
  },
  "10": {
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
        "sql": "CREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL, deleted_at INTEGER\n  CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at > 0)),\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n)"
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
        "sql": "CREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nWHEN NOT EXISTS (SELECT 1 FROM dictionaries WHERE id=OLD.dictionary_id AND deleted_at IS NOT NULL)\n OR EXISTS (SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\n OR EXISTS (SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND"
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
    "id": "db.v9-v10",
    "kind": "database",
    "from": 9,
    "to": 10,
    "requires": [
      "db.v8-v9"
    ],
    "checksum": "3d9800ee0795eab23045285dcb4fcab0e0f1d0a9a3245bd67a2dc4849735b6bb",
    "summary": "字典软删除标记及受保护的历史版本彻底删除",
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
export const approval = {"status":"approved","reviewer":"用户","date":"2026-11-11","contentDigest":"b601207d49203b7855f396c82fa653f9674dc5d02764088cb2050cf35aeb565d"};
export const releaseDigest = "f59b947484f4c93fbeb6be2e7f05df4e3f0ef472408e6ef59d5dab0717dc531e";
export const manifestChecksum = "5e52b816a648c09161d0ffbed12dcf59b3fc7441ca2896e5668d1ecd3c6b30c9";
export const releaseFiles: Record<string,string> = {
  "docs/features/2026-11-06-data-migration/execution-protocol.md": "d19242b2745323f1b2d76a23eab5118a990612d02fb6286ccac802632457f67e",
  "docs/features/2026-11-06-data-migration/release-v6.json": "e3560640299e3d0da4b5c5fa6d15c1a29abd9ad15a976b4cf16467bd6a236b8c",
  "docs/features/2026-11-06-data-migration/release-v9.json": "5cbab7bd1091dc2b2b8b987d316d3b9144dbe9ddd32c124af61b4918be1a9ff6",
  "docs/features/2026-11-06-data-migration/schema-approval-v8.json": "598a716d8e7fd04ef5a480254e3f512be5a1095336ddcc9428e3dba8e8c9e604",
  "docs/features/2026-11-06-data-migration/schema-approval.json": "58cbfca6bc7edac4a2a6d3f69d2ccd030241218dbdfc93c05811bc8d845dd099",
  "docs/features/2026-11-06-data-migration/schema-review.md": "d455fb7a86371ceb09b195933c49453db9dee2d7bb932572220aac8c827785b0",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v10.sql": "f4d81ddb90de6bc956febee35d082e2dcd7a837001f234068f36f1d798bc6ffa",
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
  "docs/features/2026-11-06-data-migration/sql/db.v9-v10.sql": "8b56ab63593bf435a0a6ab6b29340a81ac0d23363302e0db8acf9c0dbd12be8e",
  "docs/features/2026-11-06-native-only/design.md": "60e670ce9d75d0f1e3e34820566901b224086c6597bf6b313712cefb61c3ca50",
  "docs/features/2026-11-07-agent-model-configs/design.md": "2235775c1108416f87750cead9b713d3d9ecfc7cddab60c80eeb8f5948c803c0",
  "docs/features/2026-11-09-dictionaries/schema-approval-v10.json": "5541e2ab16e0f800e528afb0434377cca3473c7b87674e4fc3aa660d6df27351",
  "docs/features/2026-11-09-dictionaries/schema-review-v10.md": "d901e418af4045bff4eee5487f8ea837451db8031abcb46a651a04bafdacfa38",
  "docs/features/2026-11-09-dictionaries/schema-review-v9.md": "6b874c8b082ec71645ed2bc50a6ede9387f446a7b11c84df0169873b6cd569a9",
  "index.html": "2ccf341b5cae427d99b57d4bdbfb30f4d7bf07983b73ef53f358febaf0444f10",
  "package.json": "62e6a332982e5f19bb455f51eef2a48e5f3ac99599c1ab08558f359737ad8138",
  "pnpm-lock.yaml": "167b41ca739ec3292214819d9a62db085b8a9963a88afd6b4bc9a994c8cc643d",
  "scripts/check-migration-manifest.mjs": "cbb97ccdf867b9cf38bcc30ca6129c56d4d630218ce879b5a0a7c5b2f492493d",
  "scripts/create-migration-integrity.mjs": "2cab61886a21ad9fc401c3cbe7825f3c13d67c00ad96c67358f6f94428accd5c",
  "scripts/dev.mjs": "ccb2207256ae2268a157f05f08f9e3f084eeb06515cc11e6c4a1206507cbfe38",
  "scripts/generate-migration-bundle.mjs": "2f5af42776ba024f4525b150f50f2550f9329b47b393fbd8afee2c0916284679",
  "scripts/lock-migration-release.mjs": "70c96b1051a478895dc9deb63d79faecfa1567d6e5693f248960ad6f05218743",
  "src/authoring/agent-model-configs.ts": "76654c4197a26979fa7c002d1e92e9e4ee97bff75e76f4ff830ff7419b1a7b85",
  "src/authoring/context.ts": "385b7d5271679b03c7bc978f73b70e57986af15309758d9eaad8b422dd50625e",
  "src/authoring/conversations.ts": "b01415085b340f87e0b6354c6004f06ac35b1ddb7b8ecbb0afc961c09399a406",
  "src/authoring/default-prompts.ts": "199132f4d82f36d664b905b48b4c2b97940087d74655931640b90da4576829cb",
  "src/authoring/prompt-preview.ts": "34ab2969981365912a0cc8af2990499b17debb675517d4228867211082879fbc",
  "src/authoring/script-agent-prompt.ts": "6a6ea6cfa1dc00645fce32f4032268bbf9655599fcca0929cf805d87525e591e",
  "src/authoring/script-agent.ts": "438aaba4676d422b1c455795c4987b6f4ac47959ba59349601b183641b8762c0",
  "src/authoring/script-library.ts": "e5b12e08ec3157d5fb56a9c332b6ae78f302c22fd33dc2cefad45b04e297c534",
  "src/authoring/service.ts": "3b0df33e3a5441c4856c4a5f1cdb278c9f2624e8cbec959abf422c005d9592c3",
  "src/cli/index.ts": "440474d73e3c6d87dda73657a837dedd00f4f99a4ff462fc6c471147394d7f6c",
  "src/config-git/cli.ts": "551d7916360d850e9b28fd3df261e5f8f79f88a48bc82307781b5e87e2d65bc6",
  "src/config-git/coordinator.ts": "70e2c943d81ea78971ee1505fa0b4bb72218bc74491ed884c5694ad53e46e6ac",
  "src/config-git/dictionaries.ts": "bda007857986a11d650bbc9a7b69334cdce32c88fc7fef3fc4e18962b3042f4a",
  "src/config-git/operations.ts": "63340513d6b9ff31356fc93e6743ce3fbcfb256882967c1e587663f4670ab098",
  "src/config-git/repository.ts": "27ef26433cc6f22f73418db4a946ca3cddf27292edabc1cd406192aa458d35ae",
  "src/config-git/restore-files.ts": "48cf1ed79339e6ef5d70b14207c6f08d575c6f1060d2f1c48fc23b16124b1d1f",
  "src/config-git/restore-import.ts": "5eac59fb1b418ea9e4c98547f33fa1d305a60e40fcfaf50f80b0fadd50473adc",
  "src/config-git/restore.ts": "c54c19499e3aee6cbfcd701ee10966e4c739e0c645693850dafe52aeca6b48c6",
  "src/config-git/routes.ts": "8394df19de6220bb31c91ce047a3b1f08f281b578522bde0e07d5c9f87884600",
  "src/config-git/service.ts": "c40202f8ca5246f18ceeeb205f6f054f8f341b2741d9ace2dbe33522cf315cb7",
  "src/config-git/snapshot-primitives.ts": "17f52d9a786a927d19b28fa60cd6de8e69e8e1f38182b4107dca0758fc30ccbb",
  "src/config-git/snapshot-types.ts": "b1238a7d0a5aef197d7554297bbdeaa1076e656dc1653ef6ce39b6b9c2a025c2",
  "src/config-git/snapshot-validation.ts": "dc2507fd14034d0dd458ba7d33295beb659a885e4ea376e0f47cbe06f5c56bb0",
  "src/config-git/snapshot.ts": "44e3e4a1feaaa8ec4a3c17827e4182ca9758040d47ea427c64801b20fb669857",
  "src/dictionaries/canonical.ts": "68026a2ccf6415c92a969f16a66aae9f34b6a35e6d2432a04870554ede5a7fd7",
  "src/dictionaries/execution.ts": "f7ae0658779025e66c5fba47dc0c012726c567356f4eb6f439f75a49fcd3206f",
  "src/dictionaries/model.ts": "028fe51dc1e0af00cce5af45fddf992f74643d9677a84f4c6b7533c2eb88531f",
  "src/dictionaries/references.ts": "b6d7845628e217c3bc5aeecacf7d9e3e4d57c3b3a18d4432a0a5d6dbf80b4aab",
  "src/dictionaries/routes.ts": "650d2715f68830a96bbc137a06e1c7368c8f4518f51504f03faf94752a148974",
  "src/dictionaries/service.ts": "1ddfd9f92c5664fcc2db46fa47fa795cfd54135dd34c23cd92e2a9ebc1342f82",
  "src/dictionaries/validation.ts": "22676450343981be8936c2d17093090fc4a99885bcefca46cc0042949712a2a6",
  "src/domain/dictionaries.ts": "1d3e9e3a4b3620308fa6710d4ebeffb221dbe8221d8ff30612bbb92540949d6c",
  "src/domain/errors.ts": "bc2c4950e109eba16caf62231c321c61f4689c9d54c0e0b4e81a8aaeffa5c7a1",
  "src/domain/models.ts": "3947f43c3212d2770471f008a809d5c79ea99362fd6c1c8169ac74adab855b4e",
  "src/domain/schema-compatibility.ts": "fee333acc40a8e06c5d20dd6710ec1cd99da1aafccc36d7bef686a71a43df5c2",
  "src/domain/schema-diff.ts": "58b52daeeaf9724c26c047eb80d9fb51da94f8882e6bae6ad0a0170e725e3fcd",
  "src/domain/script-authoring.ts": "1bce0384ce902b98ccb2a435ddd0db86ca7a79384efcf6111369e0e46caeb2e1",
  "src/domain/script-test-input.ts": "39d732c0a49e3c101a1f956cd1bf2104f03f0a157aaa55ab8bec65ecb29e7ae6",
  "src/domain/scripts.ts": "325a146d49bd6968e6d89298a0e27315da825b953fc609414c406784dc752d2a",
  "src/domain/turns.ts": "8bc48474c8084d4231c833ac5377a5148649d3480d515e3632c3b987aecf4488",
  "src/domain/types.ts": "76fb3373143bbeadc39c7fc48822417831dc155c4a3dd88b92b7978a3b09f194",
  "src/domain/validation.ts": "48e7ab3a561457c4256b1284f359e56eda3da56c98a5c6c053b2d517d90de5cd",
  "src/migrations/config.ts": "7f4c89873da967575f1e96f7099eb81fc8288479014a6d5ef78d3799b03459f3",
  "src/migrations/definitions.ts": "6a46dcc41808b4b61578f7b70e05de9ca037d7c9357b9845991a7ae31d2ead3d",
  "src/migrations/journal.ts": "cfa41b539c32b6b4c39ee8d60394194c9ace4ffb88d5511c326442e463bc606b",
  "src/migrations/lock.ts": "63f6818b13aee27350e6961dbd6efbf52924477f0c37834aedbd516035b04ac5",
  "src/migrations/mapping.ts": "e42afeaae6ecb0eb50a8dbc9c16e2ff4f637b228ccf7648ca81040575be4290b",
  "src/migrations/planner.ts": "d3ef6d8c12998f2092105cd4caab3debff4bbbf60c7902430fabf6738296baeb",
  "src/migrations/preview.ts": "130c7eb237a0297ad7c159334e847349d6e441607af9be95b4f396de0853143e",
  "src/migrations/questions.ts": "d2981be8ecd70f69b140f783c2db8fe9af46b7805e3d55fe2dd8d74ac4abc040",
  "src/migrations/release.ts": "c86fcd1bdafb2ab0c96131a84774e7ffef10f3fe6b4d2eddafa5ad981411cc5a",
  "src/migrations/runner.ts": "fa4de919704c691eb1a2c295d7f9c992d2d35de702e80ce4de10dc69405ffb5d",
  "src/migrations/types.ts": "32794b6a450416bfa508ac085a3eb9afc8f393e37d1dacbf59767703090e13cc",
  "src/migrations/validators.ts": "611ea7c0caef4dae3a98d9c67fe9f4f488567d99bb78c48693af75b538b58354",
  "src/migrations/worker.ts": "abbb9442390c4d4184a134c43e4967551273c2a27f2b228e6f812c986de6ce65",
  "src/persistence/files.ts": "c17a26cceaa7a2aabcda95c20b5fad5eb082213f6afe3bc7aacf513c87b537f3",
  "src/persistence/schema.ts": "9ff9d1b8cfb13b6b6f178d06a220c7ae4b4ab321b7a34b109b43fb9b6a822d7f",
  "src/persistence/script-journal.ts": "d916b54c1997d55532b0384641e81f9059d078d7ccc6ead8168a58fba30954a7",
  "src/persistence/script-maintenance.ts": "9b57195afa356ffc6963c1398295c4512e59e5fa350e289afc8a74be532a00d6",
  "src/persistence/store.ts": "23110286d173e9492f166fd600eb1e1e8fd5716a5fc69182f3699940a3a29346",
  "src/project-git/files.ts": "537f8915ae1a3be9c94448d65405fc7a47735ea76affe6d30d0d7a17e944d3bb",
  "src/project-git/git.ts": "13d2645792db44cbe04ed90ab344e16d0e4f954591b8a32a2b3d28161d098719",
  "src/project-git/materialize.ts": "cb0477973c5c06245abe58de71a7e2dd81658e66ef1613bfe574b11bd4e5a588",
  "src/project-git/routes.ts": "f09ad57312b9f21390a5eedb37bbdf897f5a47aa7cc5d4e0bac1a04a9bff3bf1",
  "src/project-git/service.ts": "1a0fd0bc70b9dd93baefbd7a1568dc715037a1353a01ab6034e6a68109d96ccd",
  "src/project-git/ssh.ts": "d7ca92798cf5028e3c8f2043ca5174fbf22b26a99f686d8f57da3513caee821a",
  "src/project-git/types.ts": "e749d318c86734db817ac7623d8b4911ed421dd6fbf8174d15bca9115c7994c6",
  "src/providers/agent-limits.ts": "c3a26de962c275a34b902d61c0ee999158833624a337bcdf8686b5d61fe4ed35",
  "src/providers/codex-app-server.ts": "f2df6c2861b587b7e17b686bfec00e9f2c40f6fb0ffe387e1d0d7fd4f01f1ee9",
  "src/providers/codex-config.ts": "0172aee1c55490b99dcb1c9754fd37f0c903687e796ea1d0626af954337dd9e6",
  "src/providers/event-batcher.ts": "1fea4a2e47ba81903469e58a5d01f4427c1cf271f8eaeed7dce4bd75c3892229",
  "src/providers/pi-rpc.ts": "166aae9ca952348a2f010a3385a15f2b2596d890ab4f12ca406744b9c5bd3f62",
  "src/providers/registry.ts": "caea3ce7bd4ce318f813d31865a45a75a9af04e2459202d9fca5e991eda9895b",
  "src/providers/session-manager.ts": "5a756ac856fd62e6c839ec339f1281fbb32aac5c25792b9a5bef8ec6f6fd6c27",
  "src/providers/session.ts": "0ee420fa8a7ea573dea0b8b2aa551602829f57799c3106448971d92e213b107b",
  "src/providers/transport/jsonl.ts": "215f1c3b72a0cbb5f26a9156a5eca31d986d5f68f5e1c7be661c0d12ea9f9aad",
  "src/providers/transport/pending.ts": "c9eecf152a5952ef97e9bbd1ba3179d0aaf5f83222e3a248c836da7164acac28",
  "src/runtime/dictionary-context.ts": "f19ef88f8f672183bf1747f746dd8b8b546f6918f2e714ad8ec5095ddf7f1ead",
  "src/runtime/process.ts": "49845e3313352c3cc55900bb4b8e82a61767e63724f40101eeeacc15242fbdef",
  "src/runtime/runner.ts": "0b8808c5d45cdd4ba51d11bc3e5361c463128fdf7d0435235d8b33d89d95d031",
  "src/runtime/script-tests.ts": "f0e9d3d4a00892345f650ba2cbed2d01a1486357f57ab8f6b34d1f954616da77",
  "src/runtime/script.ts": "136fa17ba7068cdcea78738b90791c14828f365b068f436a27ef49ce2a1de6c5",
  "src/runtime/workflow-history.ts": "c9d170b979ff4cef1d9dff8c81e4a04e18e3b1c6b02ea54d3d66f463c7fc5e18",
  "src/secrets/aead.ts": "668fa9e6545aa226763d07f25514880c5220680938fd9cd7e41703fe7c997334",
  "src/secrets/backup.ts": "a0da9bab7bf287cc638a7ba26a11e68569f1fcaaeb0187d20cdabce554a73f42",
  "src/secrets/cli.ts": "943610612aa15b8a8dacb6e71f92d5761cf48abdd3407de5a3ce3b9e6b8f422c",
  "src/secrets/command-hmac.ts": "70726e919d926da0336ba068789292b6980951442b99f9f8974275194deffbfa",
  "src/secrets/files.ts": "c02eff05e293e84effa9dd24f5ba22cd4de0b76802f30a13a10b6acd9cb1ff27",
  "src/secrets/keyring.ts": "8e3661877d4c81176bfce2e8472bab5a4f61d80f329799e4534f3c2fc4a27f57",
  "src/secrets/keys.ts": "d86f60a3ac96288f3da5fe3da86450c2038185de6c018da8f52c52ff8dfba088",
  "src/secrets/service.ts": "09802ccab79a40b72903c3ff438662ccc64b6431db1321fabab22a77cef745bf",
  "src/server/app.ts": "9fdf397de45a5a85d5049685ff09311904708f634280a3855f7d763452d43b57",
  "src/server/bootstrap.ts": "294750eae786d119e6a9e3331939bd3f37ef7c2bbad25757c2a6e89ef7342136",
  "src/server/main.ts": "84c41c3734ec8b4c4344117636fa2b97babc780bfd4558107a2c9ee17d1a82a1",
  "src/server/notifications.ts": "d2cccda01fcf8b99c404c4c5bb83020029aa6829bcbfb7edf53652857cff7fb2",
  "src/storage/usage.ts": "776e78c5aa3a6e7a398de1765e1143df7dc5dc609d0ff97602df06d96fca8a3b",
  "src/web-bridge/agent.ts": "3537255083c3796936d050091369e4fecdebffccd1dea0a3075c22647234f22f",
  "src/web-bridge/auth.ts": "489a36654e1aa0e88e8905b51082392107845b99b9a2deb6cb80c68789d2323b",
  "src/web-bridge/authoring.ts": "a700c51c6fe3c207967985acf2b6187df1c2d5dbb4973e00446c439ad87e9dc9",
  "src/web-bridge/browser-execution.ts": "2bf972937269c4c51424f02c12b02cfe843690ced50fca6e2bed1f528287e915",
  "src/web-bridge/catalog.json": "37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570",
  "src/web-bridge/catalog.ts": "c8b5243eece81df1460c1da638c9388de1197886426ebaefb8cc861b763e3a79",
  "src/web-bridge/client.ts": "8650628ecfda5f27a7b5cd7d1d3bc5f4149cd4d2ef373814ce9d7b5e0e31d974",
  "src/web-bridge/config-validation.ts": "31f6a10cfe97ad62a7d3357b1436a1838d616bc83d34d21bce68951292c5eeb3",
  "src/web-bridge/config.ts": "c5160335e85cded56a73a5e6bf0ff2b666985de5f0e03c645fe6660d3c615293",
  "src/web-bridge/credential-inputs.ts": "26976dc75e00328c9d14d82c4a950db0d376c01be6fe82225da53ad870775551",
  "src/web-bridge/credential-schema.ts": "146008b27224e2f5e7c53177ee0cfd38b7a4a9b6e00507acc98c04a6bcd33e1f",
  "src/web-bridge/credentials.ts": "1593af732403058076c1ad0c43e0ec8a5f0455f7a61fdc5a11a584028c468f10",
  "src/web-bridge/execution.ts": "2abf4b936109ab699a4734feec245d32f50316dc0c534b183098b090f152de3f",
  "src/web-bridge/extension/background.js": "e2f358837f01c0b7b0fa2daf4dce0791979c4b9e995c0df3edabe9d874f342e7",
  "src/web-bridge/extension/manifest.json": "8e383e542fcec7c8a0b6fbe97ec6e404c56b4b4d319c8ec128b31a41eabfacd8",
  "src/web-bridge/extension/popup.css": "21ebd7a9081c304dcd1e5dbd6ab8ad9b627cece92cca9db3a59f3f2b824146b5",
  "src/web-bridge/extension/popup.html": "fb3f7563032014ae223c9a18a1b479511c384ad2414f7af03311bf31ec1b0974",
  "src/web-bridge/extension/popup.js": "d3772761f9ef15d726e5ecc8bfd0e27f755dbd443fbb9e956e9ae28e6250298b",
  "src/web-bridge/gateway.ts": "a6b687c1d43076534fc0815955f3185094ece07f386d9c5e4c3b02efa4411524",
  "src/web-bridge/history-policy.ts": "57ad19256f3eae213bd93de0f3c84e715de7c3b3c2d780e4ab8596754ea04dec",
  "src/web-bridge/history.ts": "c41e50417da6af3d650263513927a2379a9b0320ab37d037711ad3d56758391b",
  "src/web-bridge/http-methods.ts": "e2b6e7ee17ee0e78a263f170748abe38938bd24312484452388eaa73b955fece",
  "src/web-bridge/install.ts": "f5530e912faf5d8cf54362373fe381d9219aa3d80e2ac9c9c5364a09a9fd3773",
  "src/web-bridge/native-host.ts": "9ca04081fc9d389fbf3fc15242600ea72ffeb225827ce1fa6716a032fc63f1e6",
  "src/web-bridge/postprocess.ts": "ecd75c788a96980700f7a7ec3830b9d63c34ed0fe0e9f8df7069e58070ad7db1",
  "src/web-bridge/protocol.ts": "ec5d5cbae800b245075fe18cc26d4bcac43f2b4ddb1c0775a694478e1cdce0db",
  "src/web-bridge/request-path.ts": "cf6c15e717027178da3ffe4feb9070275b35ff9f0ba1ebb0706933fc26a401bc",
  "src/web-bridge/tool-identity.ts": "f6aa885ba27c0ffe5c06eded72f17cf5d692c8690fe9a42686857b4301d67aef",
  "src/web/App.tsx": "dbbe2951db0a3579420621bedf968b3248d015057043a1a562769e69e267e6f1",
  "src/web/Bootstrap.tsx": "5961b1f8c343748d0fba5dc55dd13af7fbf17c97927d70adf593e4f069fcddcb",
  "src/web/agent-chat/AgentChat.tsx": "b3ddcfc731661a137f795680f23a2016cc7ba14e7276cf4268c419f90d4106d6",
  "src/web/agent-chat/ChatHistory.tsx": "2439453d76a9862267e6179ceb10e930ca1b85a73057c766603ec23a497fc5c6",
  "src/web/agent-chat/adapters/browser-application.tsx": "a0ec11ae508b8d48f067f9b2794a9563d4502cf69c9f66eec37050a981345d03",
  "src/web/agent-chat/adapters/script.tsx": "cbb0686bd42a58d2ffa3a3dfb0c7419a851c1736ae8870866a8376013e7e9e75",
  "src/web/agent-chat/adapters/workflow.tsx": "f5dbb71c07917bf2b31a647e429d86e4a4c454d670eeaf8200fa52e038ebe7a3",
  "src/web/agent-chat/agent-chat.css": "45f0e86e089135ac63292ae3de8950cb61a33b54b205e880acad9e85e2272e09",
  "src/web/agent-chat/types.ts": "4fd2cc51ad10e0b7ec84bc5ef4d68543c72d2ada7262ce2f0ab6206ba890bf8d",
  "src/web/agent-chat/useAgentChat.ts": "c8c46cc7b45ee16ad2f97fdac1be5520cb91ebd944a6464f1639ae3bc271f074",
  "src/web/agent-chat/useChatPolling.ts": "282dd642d042f11248d1804b1255909b692bf5bc2de474887ab6a4c1bb390206",
  "src/web/components/AppSidebar.tsx": "883ecdae93356683cfb86809cc57102fee0d30725ce62b72c4e158a86d7d3a57",
  "src/web/components/ToastNotice.tsx": "b5bf06a04b28dcc916e638074ef6f0d8b1f0ce951e0c4cb410e723fb9ffdfb62",
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
  "src/web/features/AgentPromptPreview.tsx": "be84b68d7c02437f421278670f61dcf1ed965120304ca74b2db120011a3ce663",
  "src/web/features/ArchiveConversationButton.tsx": "a8b0b293239a779f183d1e45273c0b5aaf445076c10c2495945a088d8d482d63",
  "src/web/features/BridgeAgentPanel.tsx": "75b336d667e1b504e341142de436a394ad6a2abe724f2066c005e27ae86b8443",
  "src/web/features/BridgeCredentialInputs.tsx": "279eb748fb4df3689747e43fe0797e72593e788fb8cde9d5f5b480d01bf1ce5e",
  "src/web/features/BridgeExecutionHistory.tsx": "c3997a02996b03501fe38f34f97d7024ca2eb15eb8ea980fe0f17eaa45d91562",
  "src/web/features/BridgeNodeCredentials.tsx": "ba32c1ebe9597501cf3b507566a05ab4e684c77412bd10ee364f76631c93ec5f",
  "src/web/features/BridgeParameterInputs.tsx": "224a17f051a5beebcc47c3816de6232996d8e8343a2b10c759b3a568c0057e02",
  "src/web/features/BridgeToolForm.tsx": "937da89144297349d07f6b506add94246b4b237dd7b1e0d9963f0286dcc7dead",
  "src/web/features/CodeEditor.tsx": "b0c3d7540dff188ca183a32e0a6c004b65bb1b10cfcc078ec8cf7ece7dbefc8b",
  "src/web/features/ConfigGitMessageAgentSettings.tsx": "ef55f509bf064b50375aa859d1cedc78ef7046ebc703540394fb0d45d45da648",
  "src/web/features/ConfigGitSettings.tsx": "694e3ce09260140fdf3246588b419bc2ef31d102940ee237905d6184e31df0d6",
  "src/web/features/ConversationDrawer.tsx": "f5f777bd31e45f39ff0b4f405386793197bfcbda0d4e72d87cb66c6b59a0fe2a",
  "src/web/features/DeleteDictionaryButton.tsx": "65526abe69df3b1b720d5b483e30f091aaaff70f382a801ebae896ab1cfe8849",
  "src/web/features/DeleteScriptButton.tsx": "37b91e388366f3b05ebf572dae7db42c4c334507967a6546c43c42ee9931a503",
  "src/web/features/DeleteWorkflowButton.tsx": "c98b76855e29881c92dae1ee5560ed66accc55978265c455516e69be388efeff",
  "src/web/features/DictionariesPage.tsx": "afc141a137cffd404c9b52d8400e8a79adb444ee18ebdeffda259ec093ea37c0",
  "src/web/features/DictionaryEditors.tsx": "4d750465ff522254f9f8ff3495ea84cbbdcb53d8d6349fc4dc57fd7317598552",
  "src/web/features/DraftPage.tsx": "f72b21137f35397464d2818d7960a14b64bff8c93ad5ab2b504b8a1dfc339d62",
  "src/web/features/FinalResult.tsx": "178ae2f3d12d481e0d33eb1e7db253786c2ebd554b8fc4a993570b73fe389d32",
  "src/web/features/FlowCanvas.tsx": "e359cbad66510fc8f6d8d4d8e14d13adadb288e44fe80a806318a2cd77f23e8c",
  "src/web/features/GitProjectSettings.tsx": "66c330e78661cb76a0d698c20b3c1d660d8d9073bfab14d236a2c8b251b7fd15",
  "src/web/features/ModelManager.tsx": "f03693b472805a167f159fa90bc9a8285533cce1000c2189da0d2a429f4ed1b1",
  "src/web/features/ProjectContextPicker.tsx": "09a511c2900978e3edaea8ee0020efa3ba0cb331d1150eaf193033536d5bacc6",
  "src/web/features/ProviderPicker.tsx": "97ce1eaf3364e9a553ef4934e864d88b237ca61ed5054f49304e62df9657cab1",
  "src/web/features/RemoteConfigSync.tsx": "ed4a2b4b4c3694dc4781516251c924fb20ec3d1dafc22532d0e1abcbcfb1bbfb",
  "src/web/features/RunPages.tsx": "33614b41eb21894b1399cb8b042bc651e44e2997d0b35624d3b3bd2a7bc2aac7",
  "src/web/features/SchemaEditor.tsx": "9f01352f1392f3831a83d1421b72d868c654f8511279b09fd4bfefedffae54fa",
  "src/web/features/ScriptAgentPanel.tsx": "a3d549655dddd919ef75f60d5fc995d332abf46217ab9f8f03e34ee3546a7b70",
  "src/web/features/ScriptAgentPreview.tsx": "1f6b56640b63601444865eab7eadf9c3bdc60caaafd9d2901933cb40cff66d3f",
  "src/web/features/ScriptNodePicker.tsx": "e908aa883c4435cdb66f9287c9d54f1122a78e9a0ab5ead4c06324714a4b2117",
  "src/web/features/ScriptPages.tsx": "0d9cc728903930a4a7136b8e6b8bfc726417e2ba81af63d45cc45b86809ce43b",
  "src/web/features/ScriptRunInspector.tsx": "f5625915796e09c177053369f0aaa9a54060c952e5505a5b4e2ec43477208dd3",
  "src/web/features/ScriptTestParameters.tsx": "15adf2f14d7f403f7489c265913522c73a6533b618965febfc8657e6526f223a",
  "src/web/features/ScriptVersionPanels.tsx": "6ea1c719aa8e5b79ec8fdc33e70981cdef7f43a99a3f8c933208e05477d3c07f",
  "src/web/features/SecretKeySettings.tsx": "5fb8d76c4ed51a6987c86784fc5fecbbb68e92923648dd560f5c84f9a294ccab",
  "src/web/features/SettingsPage.tsx": "8a144b090056a41c0d1ec4317e0f057e746bdf9c5f572f1d51ececac7e4b08a8",
  "src/web/features/SourceTabs.tsx": "e777d5d1045395bf34860a78ef6f455d36f557ea0de01762ac64db7bec7bec48",
  "src/web/features/StorageSettings.tsx": "06604737f88ce2910e66d7c2003ba48dddbba7f4ac96f84cb8857ec043a0bade",
  "src/web/features/WebBridgeSettings.tsx": "f05a5ece5e4389e41edf7cc0b233971061d7dab9324625d85e48a0740a768f26",
  "src/web/features/WorkflowOutputEditor.tsx": "b287b056c8cee2cdfdea1acc8a71d73b8f1d74307d86970398c5fd79b73c69f5",
  "src/web/features/WorkflowPages.tsx": "4b42cc94ff3febb9a1111e0247a1513de5e577067ab7ae6e06198be96b595cf0",
  "src/web/features/agent-prompt-preview.css": "4201bb49067575c767ca5304769e4da3ca96fba21377003587c85e501c980f43",
  "src/web/features/dictionaries.css": "eee28db50fac7e1adb0a4b68267f74c25e8524823d43645bc66d8578e37b7fbd",
  "src/web/features/graph.ts": "071d4031e27e20615a79e80297fd0e6104a61c8e0b3027e3f91f6b8b9281b91f",
  "src/web/features/secret-key-settings.css": "a5b810f2b77293b3a4cea4eff27eaaef44e31ffd628242c09cd2760a21d22db6",
  "src/web/lib/api.ts": "f9a54a438d2ced9bc48154b68cf49e2f8c9e191edee98a8a69b2f46bf361ea46",
  "src/web/lib/editor-theme.ts": "ea2f3577454be160560259b32b362a91a88085ba99e33f8838098b42c5710acc",
  "src/web/lib/notifications.tsx": "13d321ceed8779aeba0d54ec444b887b6429edac3ae9cd24c229a4654272b11c",
  "src/web/lib/schema-editor.ts": "3cd38967ea2071eb3081cb17104991b1eeb8f0f28a25c526d409c631de887f10",
  "src/web/lib/theme.tsx": "a91ba0a903ebdd3f20fcd6a98074fa7dd10b7d2d54624192fbabe135232c08d5",
  "src/web/lib/utils.ts": "64fc84c1be627f0d586fb4ba64d824a1604f44282381f5bae68cdf86e10bb6ec",
  "src/web/main.tsx": "8e5a248e189ceeb39f530f4c3d438d5195689a629a9c4cce65f59f56c2ea5735",
  "src/web/styles.css": "a83d62d2b98bd0198584e489e310aac7ae9fd30bfb07bda1102ad230e69fce08",
  "tests/fixtures/migrations/config/v0-empty.json": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
  "tests/fixtures/migrations/config/v0-full.json": "c8ad3a6baf7f06bb1b403a9fefd738cbf3e9b3f74168c52762ed61abbcfadd0c",
  "tests/fixtures/migrations/config/v0-partial.json": "20401c22a2303b77d0d99d15acd00a6f824659295db2556df5bbc16351d90f38",
  "tests/fixtures/migrations/config/v1-full.json": "008abcd9e07602a8be426ace85532f1e0fb280a7817825a9acdf53c1f370f9c6",
  "tests/fixtures/migrations/database/provenance.json": "5cd4d9e38c9f45026d11c96da710961b157c22f5d3f8a7434cc4fac53fa8f1ec",
  "tests/fixtures/migrations/database/v1.sql": "3fb10171ffa8f3331bd944e141f20cda01088f944debee353cedc5e49e4dab09",
  "tests/fixtures/migrations/database/v10.sql": "3a54c945412ca01ee09804acee984b1b00f71af2da99783b70bab2470f6f4a91",
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
