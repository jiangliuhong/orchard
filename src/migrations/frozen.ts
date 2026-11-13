// Generated from the locked release manifest and historical declarative fixtures. Do not edit.
import type { MigrationDeclaration } from './types.js';
export const currentVersion = 11;
export const sql: Record<number,string> = {
  "1": "\n\nCREATE TABLE runs_v2 (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n);\n\nINSERT INTO runs_v2(id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at)\n SELECT id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at FROM runs;\nDROP TABLE runs;\nALTER TABLE runs_v2 RENAME TO runs;\nCREATE INDEX queued_runs ON runs(status,created_at);\nPRAGMA user_version = 2;\n",
  "2": "\nCREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n )\n);\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status IN ('current','needs_rebuild');\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nALTER TABLE authoring_turns ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);\nALTER TABLE authoring_turns ADD COLUMN backend_turn_id TEXT;\nALTER TABLE authoring_turns ADD COLUMN connection_generation INTEGER;\nALTER TABLE authoring_turns ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'not_sent'\n CHECK(submission_state IN ('not_sent','sending','accepted','settled'));\nALTER TABLE authoring_turns ADD COLUMN input_ref TEXT;\nALTER TABLE authoring_turns ADD COLUMN result_ref TEXT;\nALTER TABLE authoring_messages ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);\nDROP INDEX one_active_turn;\nCREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested');\nCREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);\nCREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);\nPRAGMA user_version = 3;\n",
  "3": "\nCREATE TABLE agent_conversations_v4 (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations_v4(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND transport='native' AND context_mode='native')\n  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nINSERT INTO agent_conversations_v4(\n id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,\n transport,connection_fingerprint,cli_version,backend_ref_json,backend_generation,\n synced_revision,rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at)\n SELECT id,draft_id,mode,context_mode,\n   CASE status WHEN 'archived' THEN 'idle' ELSE status END,\n   provider_id,provider_revision,model_id,transport,connection_fingerprint,cli_version,\n   backend_ref_json,backend_generation,synced_revision,rebuild_from_id,\n   NULL,\n   CASE status WHEN 'archived' THEN updated_at ELSE NULL END,\n   created_at,updated_at,last_used_at\n FROM agent_conversations;\nDROP TABLE agent_conversations;\nALTER TABLE agent_conversations_v4 RENAME TO agent_conversations;\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nPRAGMA user_version = 4;\n",
  "4": "\nCREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n);\nCREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n);\nCREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';\nCREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n);\nCREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);\nCREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);\nCREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;\nCREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;\nPRAGMA user_version = 5;\n",
  "5": "\nALTER TABLE script_versions ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000);\nPRAGMA user_version = 6;\n",
  "6": "\nCREATE TABLE agent_conversations_v7 (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations_v7(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nINSERT INTO agent_conversations_v7\n SELECT id,draft_id,mode,\n   CASE mode WHEN 'single' THEN 'isolated' ELSE 'native' END,\n   CASE WHEN transport='legacy' AND mode='multi' AND status!='archived'\n     THEN 'needs_rebuild' ELSE status END,\n   provider_id,provider_revision,model_id,'native',\n   CASE WHEN transport='legacy' THEN '' ELSE connection_fingerprint END,\n   cli_version,\n   CASE WHEN transport='legacy' THEN NULL ELSE backend_ref_json END,\n   backend_generation + CASE WHEN transport='legacy' THEN 1 ELSE 0 END,\n   CASE WHEN transport='legacy' THEN NULL ELSE synced_revision END,\n   rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at\n FROM agent_conversations;\nDROP TABLE agent_conversations;\nALTER TABLE agent_conversations_v7 RENAME TO agent_conversations;\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id) WHERE status='current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nUPDATE provider_settings\n SET config_json=json_set(config_json,'$.transport','native'),\n     revision=revision+1\n WHERE id IN ('codex-cli','pi-cli')\n   AND (json_extract(config_json,'$.transport') IS NULL\n     OR json_extract(config_json,'$.transport')!='native');\nPRAGMA user_version = 7;\n",
  "7": "\nCREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);\nCREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n);\nCREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n);\nCREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);\n PRAGMA user_version = 8;",
  "8": "\nCREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n);\nCREATE TABLE dictionary_versions (\n  id TEXT NOT NULL PRIMARY KEY,\n  dictionary_id TEXT NOT NULL,\n  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),\n  name TEXT NOT NULL\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  description TEXT NOT NULL CHECK(length(description) <= 2000),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  entries_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),\n  content_hash TEXT NOT NULL\n    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL,\n  UNIQUE(dictionary_id, version_no),\n  UNIQUE(dictionary_id, id),\n  UNIQUE(dictionary_id, id, name, kind),\n  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)\n);\nCREATE TABLE run_dictionary_bindings (\n  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(run_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX run_dictionary_bindings_by_version\n  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TABLE script_test_dictionary_bindings (\n  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(test_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX script_test_dictionary_bindings_by_version\n  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TRIGGER dictionary_versions_no_update\nBEFORE UPDATE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionaries_identity_immutable\nBEFORE UPDATE OF id, kind ON dictionaries\nWHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');\nEND;\n PRAGMA user_version = 9;",
  "9": "\nALTER TABLE dictionaries ADD COLUMN deleted_at INTEGER\n  CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at > 0));\nDROP TRIGGER dictionary_versions_no_delete;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nWHEN NOT EXISTS (SELECT 1 FROM dictionaries WHERE id=OLD.dictionary_id AND deleted_at IS NOT NULL)\n OR EXISTS (SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\n OR EXISTS (SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nPRAGMA user_version = 10;\n",
  "10": "\nCREATE TABLE bridge_configuration (\n id TEXT NOT NULL PRIMARY KEY CHECK(id='current'),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n config_json TEXT NOT NULL CHECK(CASE WHEN json_valid(config_json) THEN json_type(config_json)='object' AND length(CAST(config_json AS BLOB))<=16777216 ELSE 0 END),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991)\n);\nCREATE TABLE agent_workspace_workflow_bindings (\n draft_id TEXT NOT NULL PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,\n resource_id TEXT NOT NULL CHECK(typeof(resource_id)='text' AND length(trim(resource_id)) BETWEEN 1 AND 200 AND resource_id GLOB '[a-zA-Z0-9_-]*' AND resource_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991)\n);\nCREATE TABLE agent_workspace_projection_state (\n id TEXT NOT NULL PRIMARY KEY CHECK(id='maintenance'),\n target_generation INTEGER NOT NULL CHECK(typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991),\n synced_generation INTEGER NOT NULL CHECK(typeof(synced_generation)='integer' AND synced_generation BETWEEN 0 AND 9007199254740991 AND synced_generation<=target_generation),\n target_knowledge_hash TEXT NOT NULL CHECK(length(target_knowledge_hash)=64 AND target_knowledge_hash NOT GLOB '*[^0-9a-f]*'),\n synced_knowledge_hash TEXT CHECK(synced_knowledge_hash IS NULL OR (length(synced_knowledge_hash)=64 AND synced_knowledge_hash NOT GLOB '*[^0-9a-f]*')),\n content_hash TEXT CHECK(content_hash IS NULL OR (length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*')),\n state TEXT NOT NULL CHECK(state IN ('pending','syncing','ready','failed')),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n CHECK(state!='ready' OR (target_generation=synced_generation AND synced_knowledge_hash IS NOT NULL AND synced_knowledge_hash=target_knowledge_hash AND content_hash IS NOT NULL))\n);\nCREATE TABLE agent_maintenance_sessions (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n scenario TEXT NOT NULL CHECK(scenario IN ('workflow','script','web-bridge')),\n owner_kind TEXT NOT NULL CHECK(owner_kind IN ('workflow_draft','script_draft','browser_application')),\n owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(trim(owner_id)) BETWEEN 1 AND 200 AND owner_id GLOB '[a-zA-Z0-9_-]*' AND owner_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n owner_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(owner_scope_json) THEN json_type(owner_scope_json)='object' AND length(CAST(owner_scope_json AS BLOB))<=65536 ELSE 0 END),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(typeof(model_id)='text' AND length(trim(model_id)) BETWEEN 1 AND 500),\n contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),\n tool_policy_version TEXT NOT NULL CHECK(typeof(tool_policy_version)='text' AND length(trim(tool_policy_version)) BETWEEN 1 AND 200),\n knowledge_hash TEXT NOT NULL CHECK(length(knowledge_hash)=64 AND knowledge_hash NOT GLOB '*[^0-9a-f]*'),\n native_ref_json TEXT CHECK(native_ref_json IS NULL OR (CASE WHEN json_valid(native_ref_json) THEN json_type(native_ref_json)='object' AND length(CAST(native_ref_json AS BLOB))<=65536 ELSE 0 END)),\n native_ref_version INTEGER CHECK(native_ref_version IS NULL OR (typeof(native_ref_version)='integer' AND native_ref_version BETWEEN 1 AND 9007199254740991)),\n provider_fingerprint TEXT CHECK(provider_fingerprint IS NULL OR (length(provider_fingerprint)=64 AND provider_fingerprint NOT GLOB '*[^0-9a-f]*')),\n generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleting','deleted')),\n native_delete_state TEXT NOT NULL CHECK(native_delete_state IN ('present','pending','unknown','absent')),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n UNIQUE(id,mode),\n CHECK((scenario='workflow' AND owner_kind='workflow_draft') OR (scenario='script' AND owner_kind='script_draft') OR (scenario='web-bridge' AND owner_kind='browser_application')),\n CHECK((native_ref_json IS NULL AND native_ref_version IS NULL AND provider_fingerprint IS NULL) OR (native_ref_json IS NOT NULL AND native_ref_version IS NOT NULL AND provider_fingerprint IS NOT NULL)),\n CHECK(mode!='single' OR (native_ref_json IS NULL AND native_delete_state='absent')),\n CHECK(native_delete_state!='absent' OR native_ref_json IS NULL),\n CHECK(native_delete_state!='present' OR native_ref_json IS NOT NULL),\n CHECK(lifecycle!='deleted' OR (native_delete_state='absent' AND native_ref_json IS NULL))\n);\nCREATE TABLE agent_maintenance_tasks (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),\n generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),\n projection_generation INTEGER NOT NULL CHECK(typeof(projection_generation)='integer' AND projection_generation BETWEEN 1 AND 9007199254740991),\n projection_hash TEXT NOT NULL CHECK(length(projection_hash)=64 AND projection_hash NOT GLOB '*[^0-9a-f]*'),\n baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),\n status TEXT NOT NULL CHECK(status IN ('queued','running','stopping','succeeded','failed','cancelled','interrupted')),\n process_state TEXT NOT NULL CHECK(process_state IN ('absent','starting','running','stopping','stopped','unknown')),\n input_ref TEXT CHECK(input_ref IS NULL OR (CASE WHEN json_valid(input_ref) THEN json_type(input_ref)='object' AND length(CAST(input_ref AS BLOB))<=65536 ELSE 0 END)),\n display_output_ref TEXT CHECK(display_output_ref IS NULL OR (CASE WHEN json_valid(display_output_ref) THEN json_type(display_output_ref)='object' AND length(CAST(display_output_ref AS BLOB))<=65536 ELSE 0 END)),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n started_at INTEGER CHECK(started_at IS NULL OR (typeof(started_at)='integer' AND started_at BETWEEN 0 AND 9007199254740991)),\n ended_at INTEGER CHECK(ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN 0 AND 9007199254740991)),\n UNIQUE(id,session_id), UNIQUE(session_id,request_id), UNIQUE(session_id,sequence),\n FOREIGN KEY(session_id,mode) REFERENCES agent_maintenance_sessions(id,mode),\n CHECK(mode!='single' OR sequence=1),\n CHECK(status IN ('queued','running','stopping') OR (process_state IN ('absent','stopped') AND ended_at IS NOT NULL))\n);\nCREATE TABLE agent_maintenance_proposals (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,\n task_id TEXT NOT NULL,\n submit_request_id TEXT NOT NULL CHECK(typeof(submit_request_id)='text' AND length(trim(submit_request_id)) BETWEEN 1 AND 200),\n submit_request_hash TEXT NOT NULL CHECK(length(submit_request_hash)=64 AND submit_request_hash NOT GLOB '*[^0-9a-f]*'),\n contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),\n target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow_draft','script_draft','browser_application')),\n target_id TEXT NOT NULL CHECK(typeof(target_id)='text' AND length(trim(target_id)) BETWEEN 1 AND 200 AND target_id GLOB '[a-zA-Z0-9_-]*' AND target_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n target_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(target_scope_json) THEN json_type(target_scope_json)='object' AND length(CAST(target_scope_json AS BLOB))<=65536 ELSE 0 END),\n baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),\n body_json TEXT NOT NULL CHECK(CASE WHEN json_valid(body_json) THEN json_type(body_json)='object' AND length(CAST(body_json AS BLOB))<=8388608 ELSE 0 END),\n before_json TEXT NOT NULL CHECK(CASE WHEN json_valid(before_json) THEN json_type(before_json)='object' AND length(CAST(before_json AS BLOB))<=8388608 ELSE 0 END),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),\n state TEXT NOT NULL CHECK(state IN ('pending','confirmed','revoked','applied','conflicted','expired')),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at>created_at AND expires_at-created_at<=604800000),\n UNIQUE(actor_key,submit_request_id),\n FOREIGN KEY(task_id,session_id) REFERENCES agent_maintenance_tasks(id,session_id) ON DELETE RESTRICT\n);\nCREATE TABLE agent_maintenance_decisions (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE CASCADE,\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n action TEXT NOT NULL CHECK(action IN ('confirm','revoke')),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n valid_until INTEGER CHECK(valid_until IS NULL OR (typeof(valid_until)='integer' AND valid_until BETWEEN 0 AND 9007199254740991)),\n UNIQUE(id,proposal_id), UNIQUE(actor_key,request_id), UNIQUE(proposal_id,action),\n CHECK((action='confirm' AND valid_until IS NOT NULL AND valid_until>created_at AND valid_until-created_at<=86400000) OR (action='revoke' AND valid_until IS NULL))\n);\nCREATE TABLE agent_maintenance_apply_requests (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE RESTRICT,\n confirmation_id TEXT NOT NULL,\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n state TEXT NOT NULL CHECK(state IN ('queued','applied','conflicted','rejected')),\n target_generation INTEGER CHECK(target_generation IS NULL OR (typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991)),\n result_json TEXT CHECK(result_json IS NULL OR (CASE WHEN json_valid(result_json) THEN json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536 ELSE 0 END)),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n retry_at INTEGER CHECK(retry_at IS NULL OR (typeof(retry_at)='integer' AND retry_at BETWEEN 0 AND 9007199254740991)),\n attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 9007199254740991),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n settled_at INTEGER CHECK(settled_at IS NULL OR (typeof(settled_at)='integer' AND settled_at BETWEEN 0 AND 9007199254740991)),\n UNIQUE(actor_key,request_id),\n FOREIGN KEY(confirmation_id,proposal_id) REFERENCES agent_maintenance_decisions(id,proposal_id) ON DELETE RESTRICT,\n CHECK((state='queued' AND target_generation IS NULL AND result_json IS NULL AND settled_at IS NULL) OR (state!='queued' AND result_json IS NOT NULL AND settled_at IS NOT NULL)),\n CHECK((state='applied' AND target_generation IS NOT NULL) OR (state!='applied' AND target_generation IS NULL))\n);\nCREATE INDEX workspace_bindings_resource ON agent_workspace_workflow_bindings(resource_id,draft_id);\nCREATE INDEX maintenance_sessions_owner ON agent_maintenance_sessions(actor_key,scenario,owner_kind,owner_id,updated_at,id);\nCREATE INDEX maintenance_tasks_session ON agent_maintenance_tasks(session_id,sequence);\nCREATE UNIQUE INDEX maintenance_one_project_task ON agent_maintenance_tasks((1)) WHERE status IN ('queued','running','stopping');\nCREATE UNIQUE INDEX maintenance_one_session_task ON agent_maintenance_tasks(session_id) WHERE status IN ('queued','running','stopping');\nCREATE UNIQUE INDEX maintenance_single_task ON agent_maintenance_tasks(session_id) WHERE mode='single';\nCREATE INDEX maintenance_proposals_actor ON agent_maintenance_proposals(actor_key,state,created_at,id);\nCREATE INDEX maintenance_proposals_session ON agent_maintenance_proposals(session_id,created_at,id);\nCREATE INDEX maintenance_decisions_proposal ON agent_maintenance_decisions(proposal_id,created_at,id);\nCREATE INDEX maintenance_apply_queue ON agent_maintenance_apply_requests(state,retry_at,created_at,id) WHERE state='queued';\nCREATE UNIQUE INDEX maintenance_one_applied_proposal ON agent_maintenance_apply_requests(proposal_id) WHERE state='applied';\n\n\nCREATE TRIGGER bridge_configuration_no_replace BEFORE INSERT ON bridge_configuration\nWHEN EXISTS(SELECT 1 FROM bridge_configuration WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_workspace_workflow_bindings_no_replace BEFORE INSERT ON agent_workspace_workflow_bindings\nWHEN EXISTS(SELECT 1 FROM agent_workspace_workflow_bindings WHERE draft_id=NEW.draft_id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_workspace_projection_state_no_replace BEFORE INSERT ON agent_workspace_projection_state\nWHEN EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_sessions_no_replace BEFORE INSERT ON agent_maintenance_sessions\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_sessions WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_tasks_no_replace BEFORE INSERT ON agent_maintenance_tasks\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE id=NEW.id OR (session_id=NEW.session_id AND (request_id=NEW.request_id OR sequence=NEW.sequence OR (mode='single' AND NEW.mode='single'))) OR (NEW.status IN ('queued','running','stopping') AND status IN ('queued','running','stopping')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_proposals_no_replace BEFORE INSERT ON agent_maintenance_proposals\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_proposals WHERE id=NEW.id OR (actor_key=NEW.actor_key AND submit_request_id=NEW.submit_request_id))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_decisions_no_replace BEFORE INSERT ON agent_maintenance_decisions\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id) OR (proposal_id=NEW.proposal_id AND action=NEW.action))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_apply_requests_no_replace BEFORE INSERT ON agent_maintenance_apply_requests\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER bridge_configuration_revision_monotonic BEFORE UPDATE ON bridge_configuration\nWHEN NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_REVISION_MONOTONIC'); END;\n\n\nCREATE TRIGGER agent_workspace_workflow_bindings_identity_immutable BEFORE UPDATE ON agent_workspace_workflow_bindings\nWHEN NEW.draft_id IS NOT OLD.draft_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_workspace_projection_state_generation_monotonic BEFORE UPDATE ON agent_workspace_projection_state\nWHEN NEW.id IS NOT OLD.id OR NEW.target_generation<OLD.target_generation OR NEW.synced_generation<OLD.synced_generation\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END;\n\n\nCREATE TRIGGER agent_maintenance_sessions_identity_immutable BEFORE UPDATE ON agent_maintenance_sessions\nWHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.scenario IS NOT OLD.scenario OR NEW.owner_kind IS NOT OLD.owner_kind OR NEW.owner_id IS NOT OLD.owner_id OR NEW.owner_scope_json IS NOT OLD.owner_scope_json OR NEW.mode IS NOT OLD.mode OR NEW.provider_id IS NOT OLD.provider_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.tool_policy_version IS NOT OLD.tool_policy_version OR NEW.knowledge_hash IS NOT OLD.knowledge_hash OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_sessions_generation_monotonic BEFORE UPDATE ON agent_maintenance_sessions\nWHEN NEW.generation<OLD.generation OR NEW.revision<OLD.revision\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END;\n\n\nCREATE TRIGGER agent_maintenance_tasks_identity_immutable BEFORE UPDATE ON agent_maintenance_tasks\nWHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.mode IS NOT OLD.mode OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.sequence IS NOT OLD.sequence OR NEW.generation IS NOT OLD.generation OR NEW.projection_generation IS NOT OLD.projection_generation OR NEW.projection_hash IS NOT OLD.projection_hash OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.input_ref IS NOT OLD.input_ref OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_proposals_content_immutable BEFORE UPDATE ON agent_maintenance_proposals\nWHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.session_id IS NOT OLD.session_id OR NEW.task_id IS NOT OLD.task_id OR NEW.submit_request_id IS NOT OLD.submit_request_id OR NEW.submit_request_hash IS NOT OLD.submit_request_hash OR NEW.contract_version IS NOT OLD.contract_version OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_id IS NOT OLD.target_id OR NEW.target_scope_json IS NOT OLD.target_scope_json OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.body_json IS NOT OLD.body_json OR NEW.before_json IS NOT OLD.before_json OR NEW.content_hash IS NOT OLD.content_hash OR NEW.diff_hash IS NOT OLD.diff_hash OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONTENT_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_decisions_decision_immutable BEFORE UPDATE ON agent_maintenance_decisions\nWHEN 1\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_apply_requests_identity_immutable BEFORE UPDATE ON agent_maintenance_apply_requests\nWHEN NEW.id IS NOT OLD.id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.confirmation_id IS NOT OLD.confirmation_id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_apply_requests_result_immutable BEFORE UPDATE ON agent_maintenance_apply_requests\nWHEN OLD.state!='queued'\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_RESULT_IMMUTABLE'); END;\n\n\nCREATE TRIGGER maintenance_session_lifecycle BEFORE UPDATE OF lifecycle ON agent_maintenance_sessions\nWHEN (OLD.lifecycle='deleted' AND NEW.lifecycle!='deleted')\n OR (OLD.lifecycle='deleting' AND NEW.lifecycle='active')\n OR (NEW.lifecycle!='active' AND EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE session_id=OLD.id AND status IN ('queued','running','stopping')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_SESSION_BUSY'); END;\nCREATE TRIGGER maintenance_session_delete BEFORE DELETE ON agent_maintenance_sessions\nWHEN OLD.lifecycle!='deleted' OR OLD.native_delete_state!='absent'\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DELETE_UNCONFIRMED'); END;\nCREATE TRIGGER maintenance_task_admission BEFORE INSERT ON agent_maintenance_tasks\nWHEN NEW.status IN ('queued','running','stopping') AND NOT EXISTS(\n SELECT 1 FROM agent_maintenance_sessions s,agent_workspace_projection_state p\n WHERE s.id=NEW.session_id AND s.lifecycle='active' AND s.native_delete_state IN ('present','absent') AND s.generation=NEW.generation\n AND p.id='maintenance' AND p.state='ready' AND p.synced_generation=NEW.projection_generation\n AND p.content_hash=NEW.projection_hash AND p.target_knowledge_hash=s.knowledge_hash)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_BLOCKED'); END;\nCREATE TRIGGER maintenance_task_no_reopen BEFORE UPDATE OF status ON agent_maintenance_tasks\nWHEN OLD.status NOT IN ('queued','running','stopping') AND NEW.status IS NOT OLD.status\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_SETTLED'); END;\nCREATE TRIGGER maintenance_proposal_owner BEFORE INSERT ON agent_maintenance_proposals\nWHEN NEW.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_sessions s JOIN agent_maintenance_tasks t ON t.session_id=s.id\n WHERE s.id=NEW.session_id AND t.id=NEW.task_id AND s.actor_key=NEW.actor_key\n AND s.owner_kind=NEW.target_kind AND s.owner_id=NEW.target_id\n AND s.owner_scope_json=NEW.target_scope_json AND s.contract_version=NEW.contract_version\n AND t.baseline_json=NEW.baseline_json)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_OWNER'); END;\nCREATE TRIGGER maintenance_proposal_state BEFORE UPDATE OF state ON agent_maintenance_proposals\nWHEN NEW.state IS NOT OLD.state AND (\n OLD.state NOT IN ('pending','confirmed') OR NEW.state='pending'\n OR (NEW.state='confirmed' AND (OLD.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='confirm') OR EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke')))\n OR (NEW.state='revoked' AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke'))\n OR (NEW.state='applied' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='applied')))\n OR (NEW.state='conflicted' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='conflicted'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_STATE'); END;\nCREATE TRIGGER maintenance_decision_binding BEFORE INSERT ON agent_maintenance_decisions\nWHEN NOT EXISTS(SELECT 1 FROM agent_maintenance_proposals p WHERE p.id=NEW.proposal_id\n AND p.actor_key=NEW.actor_key AND p.content_hash=NEW.content_hash AND p.diff_hash=NEW.diff_hash\n AND NEW.created_at>=p.created_at AND NEW.created_at<p.expires_at\n AND ((NEW.action='confirm' AND p.state='pending' AND NEW.valid_until<=p.expires_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))\n OR (NEW.action='revoke' AND p.state IN ('pending','confirmed'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_BINDING'); END;\nCREATE TRIGGER maintenance_apply_confirmation BEFORE INSERT ON agent_maintenance_apply_requests\nWHEN NEW.state='applied' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id\n WHERE d.id=NEW.confirmation_id AND d.proposal_id=NEW.proposal_id AND d.action='confirm'\n AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash\n AND (NEW.state!='queued' OR (p.state='confirmed' AND d.valid_until>NEW.created_at AND p.expires_at>NEW.created_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONFIRMATION_REQUIRED'); END;\nCREATE TRIGGER maintenance_apply_commit BEFORE UPDATE OF state ON agent_maintenance_apply_requests\nWHEN NEW.state='applied' AND (\n EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping'))\n OR NOT EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id='maintenance' AND target_generation=NEW.target_generation AND state IN ('pending','syncing'))\n OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id\n WHERE d.id=NEW.confirmation_id AND p.id=NEW.proposal_id AND d.action='confirm' AND p.state='confirmed'\n AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash\n AND d.valid_until>NEW.updated_at AND p.expires_at>NEW.updated_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_APPLY_BLOCKED'); END;\n\nPRAGMA user_version=11;\n"
};
export const initializationSql = "\nCREATE TABLE provider_settings (\n id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,\n models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL\n);\nCREATE TABLE workflows (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE TABLE workflow_versions (\n id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,\n definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,\n created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)\n);\nCREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;\nCREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows\n WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)\n BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END;\nCREATE TABLE drafts (\n id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),\n revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,\n published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE TABLE authoring_turns (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,\n base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,\n conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,\n submission_state TEXT NOT NULL DEFAULT 'not_sent'\n  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),\n input_ref TEXT, result_ref TEXT\n);\nCREATE TABLE authoring_messages (\n id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),\n sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,\n conversation_id TEXT REFERENCES agent_conversations(id),\n UNIQUE(draft_id,sequence)\n);\nCREATE TABLE agent_conversations (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES agent_conversations(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n);\nCREATE UNIQUE INDEX one_current_conversation\n ON agent_conversations(draft_id)\n WHERE status = 'current';\nCREATE INDEX conversations_by_draft\n ON agent_conversations(draft_id,created_at,id);\nCREATE INDEX conversations_by_activity\n ON agent_conversations(draft_id,updated_at DESC,id);\nCREATE UNIQUE INDEX one_active_turn\n ON authoring_turns(draft_id)\n WHERE status IN ('queued','running','cancel_requested');\nCREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);\nCREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);\n\nCREATE TABLE runs (\n id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),\n status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),\n input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,\n created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,\n CHECK (\n  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)\n  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)\n )\n);\n\nCREATE INDEX queued_runs ON runs(status,created_at);\nCREATE TABLE node_runs (\n id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),\n input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,\n started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)\n);\nCREATE TABLE node_attempts (\n id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,\n status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,\n started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)\n);\n\nCREATE TABLE agent_model_configs (\n id TEXT PRIMARY KEY,\n name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),\n revision INTEGER NOT NULL CHECK(revision > 0),\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n);\nCREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);\nCREATE TABLE agent_model_config_revisions (\n config_id TEXT NOT NULL REFERENCES agent_model_configs(id),\n revision INTEGER NOT NULL CHECK(revision > 0),\n name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),\n description TEXT NOT NULL CHECK(length(description) <= 2000),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),\n enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(config_id,revision)\n);\nCREATE TABLE run_agent_bindings (\n run_id TEXT NOT NULL, node_id TEXT NOT NULL,\n config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n created_at INTEGER NOT NULL,\n PRIMARY KEY(run_id,node_id),\n FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,\n FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)\n);\nCREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);\n\nCREATE TABLE stream_events (\n stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,\n event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,\n PRIMARY KEY(stream_type,stream_id,sequence)\n);\nCREATE TABLE artifacts (\n id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,\n byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL\n);\nCREATE TABLE command_receipts (\n scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)\n);\nCREATE TABLE scripts (\n id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',\n runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),\n status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),\n current_draft_version_id TEXT, current_published_version_id TEXT,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER\n);\nCREATE TABLE script_versions (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),\n entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,\n source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,\n created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,\n UNIQUE(script_id,version_no)\n);\nCREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';\nCREATE TABLE script_tests (\n id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),\n draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),\n input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,\n duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,\n CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)\n   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))\n);\nCREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);\nCREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);\nCREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts\nWHEN NEW.current_draft_version_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;\nCREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions\nWHEN OLD.status='published'\nBEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;\n\nCREATE TABLE dictionaries (\n  id TEXT NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL COLLATE NOCASE UNIQUE\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  current_version_id TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  UNIQUE(id, kind),\n  FOREIGN KEY(id, current_version_id, name, kind)\n    REFERENCES dictionary_versions(dictionary_id, id, name, kind)\n    DEFERRABLE INITIALLY DEFERRED\n);\nCREATE TABLE dictionary_versions (\n  id TEXT NOT NULL PRIMARY KEY,\n  dictionary_id TEXT NOT NULL,\n  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),\n  name TEXT NOT NULL\n    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),\n  description TEXT NOT NULL CHECK(length(description) <= 2000),\n  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  entries_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),\n  content_hash TEXT NOT NULL\n    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL,\n  UNIQUE(dictionary_id, version_no),\n  UNIQUE(dictionary_id, id),\n  UNIQUE(dictionary_id, id, name, kind),\n  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)\n);\nCREATE TABLE run_dictionary_bindings (\n  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(run_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX run_dictionary_bindings_by_version\n  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TABLE script_test_dictionary_bindings (\n  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,\n  dictionary_id TEXT NOT NULL,\n  dictionary_version_id TEXT NOT NULL,\n  keys_json TEXT NOT NULL\n    CHECK(CASE WHEN json_valid(keys_json)\n      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(test_id, dictionary_id),\n  FOREIGN KEY(dictionary_id, dictionary_version_id)\n    REFERENCES dictionary_versions(dictionary_id, id)\n);\nCREATE INDEX script_test_dictionary_bindings_by_version\n  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);\nCREATE TRIGGER dictionary_versions_no_update\nBEFORE UPDATE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nCREATE TRIGGER dictionaries_identity_immutable\nBEFORE UPDATE OF id, kind ON dictionaries\nWHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');\nEND;\n\n\nALTER TABLE dictionaries ADD COLUMN deleted_at INTEGER\n  CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at > 0));\nDROP TRIGGER dictionary_versions_no_delete;\nCREATE TRIGGER dictionary_versions_no_delete\nBEFORE DELETE ON dictionary_versions\nWHEN NOT EXISTS (SELECT 1 FROM dictionaries WHERE id=OLD.dictionary_id AND deleted_at IS NOT NULL)\n OR EXISTS (SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\n OR EXISTS (SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)\nBEGIN\n  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');\nEND;\nPRAGMA user_version = 10;\n\nPRAGMA application_id = 1331110449;\nPRAGMA user_version = 10;\n\n\nCREATE TABLE bridge_configuration (\n id TEXT NOT NULL PRIMARY KEY CHECK(id='current'),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n config_json TEXT NOT NULL CHECK(CASE WHEN json_valid(config_json) THEN json_type(config_json)='object' AND length(CAST(config_json AS BLOB))<=16777216 ELSE 0 END),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991)\n);\nCREATE TABLE agent_workspace_workflow_bindings (\n draft_id TEXT NOT NULL PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,\n resource_id TEXT NOT NULL CHECK(typeof(resource_id)='text' AND length(trim(resource_id)) BETWEEN 1 AND 200 AND resource_id GLOB '[a-zA-Z0-9_-]*' AND resource_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991)\n);\nCREATE TABLE agent_workspace_projection_state (\n id TEXT NOT NULL PRIMARY KEY CHECK(id='maintenance'),\n target_generation INTEGER NOT NULL CHECK(typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991),\n synced_generation INTEGER NOT NULL CHECK(typeof(synced_generation)='integer' AND synced_generation BETWEEN 0 AND 9007199254740991 AND synced_generation<=target_generation),\n target_knowledge_hash TEXT NOT NULL CHECK(length(target_knowledge_hash)=64 AND target_knowledge_hash NOT GLOB '*[^0-9a-f]*'),\n synced_knowledge_hash TEXT CHECK(synced_knowledge_hash IS NULL OR (length(synced_knowledge_hash)=64 AND synced_knowledge_hash NOT GLOB '*[^0-9a-f]*')),\n content_hash TEXT CHECK(content_hash IS NULL OR (length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*')),\n state TEXT NOT NULL CHECK(state IN ('pending','syncing','ready','failed')),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n CHECK(state!='ready' OR (target_generation=synced_generation AND synced_knowledge_hash IS NOT NULL AND synced_knowledge_hash=target_knowledge_hash AND content_hash IS NOT NULL))\n);\nCREATE TABLE agent_maintenance_sessions (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n scenario TEXT NOT NULL CHECK(scenario IN ('workflow','script','web-bridge')),\n owner_kind TEXT NOT NULL CHECK(owner_kind IN ('workflow_draft','script_draft','browser_application')),\n owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(trim(owner_id)) BETWEEN 1 AND 200 AND owner_id GLOB '[a-zA-Z0-9_-]*' AND owner_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n owner_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(owner_scope_json) THEN json_type(owner_scope_json)='object' AND length(CAST(owner_scope_json AS BLOB))<=65536 ELSE 0 END),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(typeof(model_id)='text' AND length(trim(model_id)) BETWEEN 1 AND 500),\n contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),\n tool_policy_version TEXT NOT NULL CHECK(typeof(tool_policy_version)='text' AND length(trim(tool_policy_version)) BETWEEN 1 AND 200),\n knowledge_hash TEXT NOT NULL CHECK(length(knowledge_hash)=64 AND knowledge_hash NOT GLOB '*[^0-9a-f]*'),\n native_ref_json TEXT CHECK(native_ref_json IS NULL OR (CASE WHEN json_valid(native_ref_json) THEN json_type(native_ref_json)='object' AND length(CAST(native_ref_json AS BLOB))<=65536 ELSE 0 END)),\n native_ref_version INTEGER CHECK(native_ref_version IS NULL OR (typeof(native_ref_version)='integer' AND native_ref_version BETWEEN 1 AND 9007199254740991)),\n provider_fingerprint TEXT CHECK(provider_fingerprint IS NULL OR (length(provider_fingerprint)=64 AND provider_fingerprint NOT GLOB '*[^0-9a-f]*')),\n generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleting','deleted')),\n native_delete_state TEXT NOT NULL CHECK(native_delete_state IN ('present','pending','unknown','absent')),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n UNIQUE(id,mode),\n CHECK((scenario='workflow' AND owner_kind='workflow_draft') OR (scenario='script' AND owner_kind='script_draft') OR (scenario='web-bridge' AND owner_kind='browser_application')),\n CHECK((native_ref_json IS NULL AND native_ref_version IS NULL AND provider_fingerprint IS NULL) OR (native_ref_json IS NOT NULL AND native_ref_version IS NOT NULL AND provider_fingerprint IS NOT NULL)),\n CHECK(mode!='single' OR (native_ref_json IS NULL AND native_delete_state='absent')),\n CHECK(native_delete_state!='absent' OR native_ref_json IS NULL),\n CHECK(native_delete_state!='present' OR native_ref_json IS NOT NULL),\n CHECK(lifecycle!='deleted' OR (native_delete_state='absent' AND native_ref_json IS NULL))\n);\nCREATE TABLE agent_maintenance_tasks (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),\n generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),\n projection_generation INTEGER NOT NULL CHECK(typeof(projection_generation)='integer' AND projection_generation BETWEEN 1 AND 9007199254740991),\n projection_hash TEXT NOT NULL CHECK(length(projection_hash)=64 AND projection_hash NOT GLOB '*[^0-9a-f]*'),\n baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),\n status TEXT NOT NULL CHECK(status IN ('queued','running','stopping','succeeded','failed','cancelled','interrupted')),\n process_state TEXT NOT NULL CHECK(process_state IN ('absent','starting','running','stopping','stopped','unknown')),\n input_ref TEXT CHECK(input_ref IS NULL OR (CASE WHEN json_valid(input_ref) THEN json_type(input_ref)='object' AND length(CAST(input_ref AS BLOB))<=65536 ELSE 0 END)),\n display_output_ref TEXT CHECK(display_output_ref IS NULL OR (CASE WHEN json_valid(display_output_ref) THEN json_type(display_output_ref)='object' AND length(CAST(display_output_ref AS BLOB))<=65536 ELSE 0 END)),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n started_at INTEGER CHECK(started_at IS NULL OR (typeof(started_at)='integer' AND started_at BETWEEN 0 AND 9007199254740991)),\n ended_at INTEGER CHECK(ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN 0 AND 9007199254740991)),\n UNIQUE(id,session_id), UNIQUE(session_id,request_id), UNIQUE(session_id,sequence),\n FOREIGN KEY(session_id,mode) REFERENCES agent_maintenance_sessions(id,mode),\n CHECK(mode!='single' OR sequence=1),\n CHECK(status IN ('queued','running','stopping') OR (process_state IN ('absent','stopped') AND ended_at IS NOT NULL))\n);\nCREATE TABLE agent_maintenance_proposals (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,\n task_id TEXT NOT NULL,\n submit_request_id TEXT NOT NULL CHECK(typeof(submit_request_id)='text' AND length(trim(submit_request_id)) BETWEEN 1 AND 200),\n submit_request_hash TEXT NOT NULL CHECK(length(submit_request_hash)=64 AND submit_request_hash NOT GLOB '*[^0-9a-f]*'),\n contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),\n target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow_draft','script_draft','browser_application')),\n target_id TEXT NOT NULL CHECK(typeof(target_id)='text' AND length(trim(target_id)) BETWEEN 1 AND 200 AND target_id GLOB '[a-zA-Z0-9_-]*' AND target_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n target_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(target_scope_json) THEN json_type(target_scope_json)='object' AND length(CAST(target_scope_json AS BLOB))<=65536 ELSE 0 END),\n baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),\n body_json TEXT NOT NULL CHECK(CASE WHEN json_valid(body_json) THEN json_type(body_json)='object' AND length(CAST(body_json AS BLOB))<=8388608 ELSE 0 END),\n before_json TEXT NOT NULL CHECK(CASE WHEN json_valid(before_json) THEN json_type(before_json)='object' AND length(CAST(before_json AS BLOB))<=8388608 ELSE 0 END),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),\n state TEXT NOT NULL CHECK(state IN ('pending','confirmed','revoked','applied','conflicted','expired')),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at>created_at AND expires_at-created_at<=604800000),\n UNIQUE(actor_key,submit_request_id),\n FOREIGN KEY(task_id,session_id) REFERENCES agent_maintenance_tasks(id,session_id) ON DELETE RESTRICT\n);\nCREATE TABLE agent_maintenance_decisions (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE CASCADE,\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n action TEXT NOT NULL CHECK(action IN ('confirm','revoke')),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n valid_until INTEGER CHECK(valid_until IS NULL OR (typeof(valid_until)='integer' AND valid_until BETWEEN 0 AND 9007199254740991)),\n UNIQUE(id,proposal_id), UNIQUE(actor_key,request_id), UNIQUE(proposal_id,action),\n CHECK((action='confirm' AND valid_until IS NOT NULL AND valid_until>created_at AND valid_until-created_at<=86400000) OR (action='revoke' AND valid_until IS NULL))\n);\nCREATE TABLE agent_maintenance_apply_requests (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE RESTRICT,\n confirmation_id TEXT NOT NULL,\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n state TEXT NOT NULL CHECK(state IN ('queued','applied','conflicted','rejected')),\n target_generation INTEGER CHECK(target_generation IS NULL OR (typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991)),\n result_json TEXT CHECK(result_json IS NULL OR (CASE WHEN json_valid(result_json) THEN json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536 ELSE 0 END)),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n retry_at INTEGER CHECK(retry_at IS NULL OR (typeof(retry_at)='integer' AND retry_at BETWEEN 0 AND 9007199254740991)),\n attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 9007199254740991),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n settled_at INTEGER CHECK(settled_at IS NULL OR (typeof(settled_at)='integer' AND settled_at BETWEEN 0 AND 9007199254740991)),\n UNIQUE(actor_key,request_id),\n FOREIGN KEY(confirmation_id,proposal_id) REFERENCES agent_maintenance_decisions(id,proposal_id) ON DELETE RESTRICT,\n CHECK((state='queued' AND target_generation IS NULL AND result_json IS NULL AND settled_at IS NULL) OR (state!='queued' AND result_json IS NOT NULL AND settled_at IS NOT NULL)),\n CHECK((state='applied' AND target_generation IS NOT NULL) OR (state!='applied' AND target_generation IS NULL))\n);\nCREATE INDEX workspace_bindings_resource ON agent_workspace_workflow_bindings(resource_id,draft_id);\nCREATE INDEX maintenance_sessions_owner ON agent_maintenance_sessions(actor_key,scenario,owner_kind,owner_id,updated_at,id);\nCREATE INDEX maintenance_tasks_session ON agent_maintenance_tasks(session_id,sequence);\nCREATE UNIQUE INDEX maintenance_one_project_task ON agent_maintenance_tasks((1)) WHERE status IN ('queued','running','stopping');\nCREATE UNIQUE INDEX maintenance_one_session_task ON agent_maintenance_tasks(session_id) WHERE status IN ('queued','running','stopping');\nCREATE UNIQUE INDEX maintenance_single_task ON agent_maintenance_tasks(session_id) WHERE mode='single';\nCREATE INDEX maintenance_proposals_actor ON agent_maintenance_proposals(actor_key,state,created_at,id);\nCREATE INDEX maintenance_proposals_session ON agent_maintenance_proposals(session_id,created_at,id);\nCREATE INDEX maintenance_decisions_proposal ON agent_maintenance_decisions(proposal_id,created_at,id);\nCREATE INDEX maintenance_apply_queue ON agent_maintenance_apply_requests(state,retry_at,created_at,id) WHERE state='queued';\nCREATE UNIQUE INDEX maintenance_one_applied_proposal ON agent_maintenance_apply_requests(proposal_id) WHERE state='applied';\n\n\nCREATE TRIGGER bridge_configuration_no_replace BEFORE INSERT ON bridge_configuration\nWHEN EXISTS(SELECT 1 FROM bridge_configuration WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_workspace_workflow_bindings_no_replace BEFORE INSERT ON agent_workspace_workflow_bindings\nWHEN EXISTS(SELECT 1 FROM agent_workspace_workflow_bindings WHERE draft_id=NEW.draft_id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_workspace_projection_state_no_replace BEFORE INSERT ON agent_workspace_projection_state\nWHEN EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_sessions_no_replace BEFORE INSERT ON agent_maintenance_sessions\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_sessions WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_tasks_no_replace BEFORE INSERT ON agent_maintenance_tasks\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE id=NEW.id OR (session_id=NEW.session_id AND (request_id=NEW.request_id OR sequence=NEW.sequence OR (mode='single' AND NEW.mode='single'))) OR (NEW.status IN ('queued','running','stopping') AND status IN ('queued','running','stopping')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_proposals_no_replace BEFORE INSERT ON agent_maintenance_proposals\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_proposals WHERE id=NEW.id OR (actor_key=NEW.actor_key AND submit_request_id=NEW.submit_request_id))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_decisions_no_replace BEFORE INSERT ON agent_maintenance_decisions\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id) OR (proposal_id=NEW.proposal_id AND action=NEW.action))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER agent_maintenance_apply_requests_no_replace BEFORE INSERT ON agent_maintenance_apply_requests\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;\n\n\nCREATE TRIGGER bridge_configuration_revision_monotonic BEFORE UPDATE ON bridge_configuration\nWHEN NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_REVISION_MONOTONIC'); END;\n\n\nCREATE TRIGGER agent_workspace_workflow_bindings_identity_immutable BEFORE UPDATE ON agent_workspace_workflow_bindings\nWHEN NEW.draft_id IS NOT OLD.draft_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_workspace_projection_state_generation_monotonic BEFORE UPDATE ON agent_workspace_projection_state\nWHEN NEW.id IS NOT OLD.id OR NEW.target_generation<OLD.target_generation OR NEW.synced_generation<OLD.synced_generation\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END;\n\n\nCREATE TRIGGER agent_maintenance_sessions_identity_immutable BEFORE UPDATE ON agent_maintenance_sessions\nWHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.scenario IS NOT OLD.scenario OR NEW.owner_kind IS NOT OLD.owner_kind OR NEW.owner_id IS NOT OLD.owner_id OR NEW.owner_scope_json IS NOT OLD.owner_scope_json OR NEW.mode IS NOT OLD.mode OR NEW.provider_id IS NOT OLD.provider_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.tool_policy_version IS NOT OLD.tool_policy_version OR NEW.knowledge_hash IS NOT OLD.knowledge_hash OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_sessions_generation_monotonic BEFORE UPDATE ON agent_maintenance_sessions\nWHEN NEW.generation<OLD.generation OR NEW.revision<OLD.revision\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END;\n\n\nCREATE TRIGGER agent_maintenance_tasks_identity_immutable BEFORE UPDATE ON agent_maintenance_tasks\nWHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.mode IS NOT OLD.mode OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.sequence IS NOT OLD.sequence OR NEW.generation IS NOT OLD.generation OR NEW.projection_generation IS NOT OLD.projection_generation OR NEW.projection_hash IS NOT OLD.projection_hash OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.input_ref IS NOT OLD.input_ref OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_proposals_content_immutable BEFORE UPDATE ON agent_maintenance_proposals\nWHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.session_id IS NOT OLD.session_id OR NEW.task_id IS NOT OLD.task_id OR NEW.submit_request_id IS NOT OLD.submit_request_id OR NEW.submit_request_hash IS NOT OLD.submit_request_hash OR NEW.contract_version IS NOT OLD.contract_version OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_id IS NOT OLD.target_id OR NEW.target_scope_json IS NOT OLD.target_scope_json OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.body_json IS NOT OLD.body_json OR NEW.before_json IS NOT OLD.before_json OR NEW.content_hash IS NOT OLD.content_hash OR NEW.diff_hash IS NOT OLD.diff_hash OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONTENT_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_decisions_decision_immutable BEFORE UPDATE ON agent_maintenance_decisions\nWHEN 1\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_apply_requests_identity_immutable BEFORE UPDATE ON agent_maintenance_apply_requests\nWHEN NEW.id IS NOT OLD.id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.confirmation_id IS NOT OLD.confirmation_id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END;\n\n\nCREATE TRIGGER agent_maintenance_apply_requests_result_immutable BEFORE UPDATE ON agent_maintenance_apply_requests\nWHEN OLD.state!='queued'\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_RESULT_IMMUTABLE'); END;\n\n\nCREATE TRIGGER maintenance_session_lifecycle BEFORE UPDATE OF lifecycle ON agent_maintenance_sessions\nWHEN (OLD.lifecycle='deleted' AND NEW.lifecycle!='deleted')\n OR (OLD.lifecycle='deleting' AND NEW.lifecycle='active')\n OR (NEW.lifecycle!='active' AND EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE session_id=OLD.id AND status IN ('queued','running','stopping')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_SESSION_BUSY'); END;\nCREATE TRIGGER maintenance_session_delete BEFORE DELETE ON agent_maintenance_sessions\nWHEN OLD.lifecycle!='deleted' OR OLD.native_delete_state!='absent'\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DELETE_UNCONFIRMED'); END;\nCREATE TRIGGER maintenance_task_admission BEFORE INSERT ON agent_maintenance_tasks\nWHEN NEW.status IN ('queued','running','stopping') AND NOT EXISTS(\n SELECT 1 FROM agent_maintenance_sessions s,agent_workspace_projection_state p\n WHERE s.id=NEW.session_id AND s.lifecycle='active' AND s.native_delete_state IN ('present','absent') AND s.generation=NEW.generation\n AND p.id='maintenance' AND p.state='ready' AND p.synced_generation=NEW.projection_generation\n AND p.content_hash=NEW.projection_hash AND p.target_knowledge_hash=s.knowledge_hash)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_BLOCKED'); END;\nCREATE TRIGGER maintenance_task_no_reopen BEFORE UPDATE OF status ON agent_maintenance_tasks\nWHEN OLD.status NOT IN ('queued','running','stopping') AND NEW.status IS NOT OLD.status\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_SETTLED'); END;\nCREATE TRIGGER maintenance_proposal_owner BEFORE INSERT ON agent_maintenance_proposals\nWHEN NEW.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_sessions s JOIN agent_maintenance_tasks t ON t.session_id=s.id\n WHERE s.id=NEW.session_id AND t.id=NEW.task_id AND s.actor_key=NEW.actor_key\n AND s.owner_kind=NEW.target_kind AND s.owner_id=NEW.target_id\n AND s.owner_scope_json=NEW.target_scope_json AND s.contract_version=NEW.contract_version\n AND t.baseline_json=NEW.baseline_json)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_OWNER'); END;\nCREATE TRIGGER maintenance_proposal_state BEFORE UPDATE OF state ON agent_maintenance_proposals\nWHEN NEW.state IS NOT OLD.state AND (\n OLD.state NOT IN ('pending','confirmed') OR NEW.state='pending'\n OR (NEW.state='confirmed' AND (OLD.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='confirm') OR EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke')))\n OR (NEW.state='revoked' AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke'))\n OR (NEW.state='applied' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='applied')))\n OR (NEW.state='conflicted' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='conflicted'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_STATE'); END;\nCREATE TRIGGER maintenance_decision_binding BEFORE INSERT ON agent_maintenance_decisions\nWHEN NOT EXISTS(SELECT 1 FROM agent_maintenance_proposals p WHERE p.id=NEW.proposal_id\n AND p.actor_key=NEW.actor_key AND p.content_hash=NEW.content_hash AND p.diff_hash=NEW.diff_hash\n AND NEW.created_at>=p.created_at AND NEW.created_at<p.expires_at\n AND ((NEW.action='confirm' AND p.state='pending' AND NEW.valid_until<=p.expires_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))\n OR (NEW.action='revoke' AND p.state IN ('pending','confirmed'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_BINDING'); END;\nCREATE TRIGGER maintenance_apply_confirmation BEFORE INSERT ON agent_maintenance_apply_requests\nWHEN NEW.state='applied' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id\n WHERE d.id=NEW.confirmation_id AND d.proposal_id=NEW.proposal_id AND d.action='confirm'\n AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash\n AND (NEW.state!='queued' OR (p.state='confirmed' AND d.valid_until>NEW.created_at AND p.expires_at>NEW.created_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONFIRMATION_REQUIRED'); END;\nCREATE TRIGGER maintenance_apply_commit BEFORE UPDATE OF state ON agent_maintenance_apply_requests\nWHEN NEW.state='applied' AND (\n EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping'))\n OR NOT EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id='maintenance' AND target_generation=NEW.target_generation AND state IN ('pending','syncing'))\n OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id\n WHERE d.id=NEW.confirmation_id AND p.id=NEW.proposal_id AND d.action='confirm' AND p.state='confirmed'\n AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash\n AND d.valid_until>NEW.updated_at AND p.expires_at>NEW.updated_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_APPLY_BLOCKED'); END;\n\nPRAGMA user_version=11;\n";
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
  },
  "11": {
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
        "name": "maintenance_apply_queue",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE INDEX maintenance_apply_queue ON agent_maintenance_apply_requests(state,retry_at,created_at,id) WHERE state='queued'"
      },
      {
        "type": "index",
        "name": "maintenance_decisions_proposal",
        "tbl_name": "agent_maintenance_decisions",
        "sql": "CREATE INDEX maintenance_decisions_proposal ON agent_maintenance_decisions(proposal_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "maintenance_one_applied_proposal",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE UNIQUE INDEX maintenance_one_applied_proposal ON agent_maintenance_apply_requests(proposal_id) WHERE state='applied'"
      },
      {
        "type": "index",
        "name": "maintenance_one_project_task",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE UNIQUE INDEX maintenance_one_project_task ON agent_maintenance_tasks((1)) WHERE status IN ('queued','running','stopping')"
      },
      {
        "type": "index",
        "name": "maintenance_one_session_task",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE UNIQUE INDEX maintenance_one_session_task ON agent_maintenance_tasks(session_id) WHERE status IN ('queued','running','stopping')"
      },
      {
        "type": "index",
        "name": "maintenance_proposals_actor",
        "tbl_name": "agent_maintenance_proposals",
        "sql": "CREATE INDEX maintenance_proposals_actor ON agent_maintenance_proposals(actor_key,state,created_at,id)"
      },
      {
        "type": "index",
        "name": "maintenance_proposals_session",
        "tbl_name": "agent_maintenance_proposals",
        "sql": "CREATE INDEX maintenance_proposals_session ON agent_maintenance_proposals(session_id,created_at,id)"
      },
      {
        "type": "index",
        "name": "maintenance_sessions_owner",
        "tbl_name": "agent_maintenance_sessions",
        "sql": "CREATE INDEX maintenance_sessions_owner ON agent_maintenance_sessions(actor_key,scenario,owner_kind,owner_id,updated_at,id)"
      },
      {
        "type": "index",
        "name": "maintenance_single_task",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE UNIQUE INDEX maintenance_single_task ON agent_maintenance_tasks(session_id) WHERE mode='single'"
      },
      {
        "type": "index",
        "name": "maintenance_tasks_session",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE INDEX maintenance_tasks_session ON agent_maintenance_tasks(session_id,sequence)"
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
        "type": "index",
        "name": "workspace_bindings_resource",
        "tbl_name": "agent_workspace_workflow_bindings",
        "sql": "CREATE INDEX workspace_bindings_resource ON agent_workspace_workflow_bindings(resource_id,draft_id)"
      },
      {
        "type": "table",
        "name": "agent_conversations",
        "tbl_name": "agent_conversations",
        "sql": "CREATE TABLE \"agent_conversations\" (\n id TEXT PRIMARY KEY,\n draft_id TEXT NOT NULL REFERENCES drafts(id),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),\n status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),\n model_id TEXT NOT NULL,\n transport TEXT NOT NULL CHECK(transport = 'native'),\n connection_fingerprint TEXT NOT NULL,\n cli_version TEXT,\n backend_ref_json TEXT,\n backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),\n synced_revision INTEGER CHECK(synced_revision >= 0),\n rebuild_from_id TEXT REFERENCES \"agent_conversations\"(id),\n title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),\n archived_at INTEGER,\n created_at INTEGER NOT NULL,\n updated_at INTEGER NOT NULL,\n last_used_at INTEGER,\n CHECK (\n  (mode='single' AND context_mode='isolated')\n  OR (mode='multi' AND context_mode='native')\n ),\n CHECK (status != 'archived' OR archived_at IS NOT NULL)\n)"
      },
      {
        "type": "table",
        "name": "agent_maintenance_apply_requests",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE TABLE agent_maintenance_apply_requests (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE RESTRICT,\n confirmation_id TEXT NOT NULL,\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n state TEXT NOT NULL CHECK(state IN ('queued','applied','conflicted','rejected')),\n target_generation INTEGER CHECK(target_generation IS NULL OR (typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991)),\n result_json TEXT CHECK(result_json IS NULL OR (CASE WHEN json_valid(result_json) THEN json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536 ELSE 0 END)),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n retry_at INTEGER CHECK(retry_at IS NULL OR (typeof(retry_at)='integer' AND retry_at BETWEEN 0 AND 9007199254740991)),\n attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 9007199254740991),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n settled_at INTEGER CHECK(settled_at IS NULL OR (typeof(settled_at)='integer' AND settled_at BETWEEN 0 AND 9007199254740991)),\n UNIQUE(actor_key,request_id),\n FOREIGN KEY(confirmation_id,proposal_id) REFERENCES agent_maintenance_decisions(id,proposal_id) ON DELETE RESTRICT,\n CHECK((state='queued' AND target_generation IS NULL AND result_json IS NULL AND settled_at IS NULL) OR (state!='queued' AND result_json IS NOT NULL AND settled_at IS NOT NULL)),\n CHECK((state='applied' AND target_generation IS NOT NULL) OR (state!='applied' AND target_generation IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "agent_maintenance_decisions",
        "tbl_name": "agent_maintenance_decisions",
        "sql": "CREATE TABLE agent_maintenance_decisions (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE CASCADE,\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n action TEXT NOT NULL CHECK(action IN ('confirm','revoke')),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n valid_until INTEGER CHECK(valid_until IS NULL OR (typeof(valid_until)='integer' AND valid_until BETWEEN 0 AND 9007199254740991)),\n UNIQUE(id,proposal_id), UNIQUE(actor_key,request_id), UNIQUE(proposal_id,action),\n CHECK((action='confirm' AND valid_until IS NOT NULL AND valid_until>created_at AND valid_until-created_at<=86400000) OR (action='revoke' AND valid_until IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "agent_maintenance_proposals",
        "tbl_name": "agent_maintenance_proposals",
        "sql": "CREATE TABLE agent_maintenance_proposals (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,\n task_id TEXT NOT NULL,\n submit_request_id TEXT NOT NULL CHECK(typeof(submit_request_id)='text' AND length(trim(submit_request_id)) BETWEEN 1 AND 200),\n submit_request_hash TEXT NOT NULL CHECK(length(submit_request_hash)=64 AND submit_request_hash NOT GLOB '*[^0-9a-f]*'),\n contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),\n target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow_draft','script_draft','browser_application')),\n target_id TEXT NOT NULL CHECK(typeof(target_id)='text' AND length(trim(target_id)) BETWEEN 1 AND 200 AND target_id GLOB '[a-zA-Z0-9_-]*' AND target_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n target_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(target_scope_json) THEN json_type(target_scope_json)='object' AND length(CAST(target_scope_json AS BLOB))<=65536 ELSE 0 END),\n baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),\n body_json TEXT NOT NULL CHECK(CASE WHEN json_valid(body_json) THEN json_type(body_json)='object' AND length(CAST(body_json AS BLOB))<=8388608 ELSE 0 END),\n before_json TEXT NOT NULL CHECK(CASE WHEN json_valid(before_json) THEN json_type(before_json)='object' AND length(CAST(before_json AS BLOB))<=8388608 ELSE 0 END),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n diff_hash TEXT NOT NULL CHECK(length(diff_hash)=64 AND diff_hash NOT GLOB '*[^0-9a-f]*'),\n state TEXT NOT NULL CHECK(state IN ('pending','confirmed','revoked','applied','conflicted','expired')),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at>created_at AND expires_at-created_at<=604800000),\n UNIQUE(actor_key,submit_request_id),\n FOREIGN KEY(task_id,session_id) REFERENCES agent_maintenance_tasks(id,session_id) ON DELETE RESTRICT\n)"
      },
      {
        "type": "table",
        "name": "agent_maintenance_sessions",
        "tbl_name": "agent_maintenance_sessions",
        "sql": "CREATE TABLE agent_maintenance_sessions (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n actor_key TEXT NOT NULL CHECK(typeof(actor_key)='text' AND length(trim(actor_key)) BETWEEN 1 AND 200),\n scenario TEXT NOT NULL CHECK(scenario IN ('workflow','script','web-bridge')),\n owner_kind TEXT NOT NULL CHECK(owner_kind IN ('workflow_draft','script_draft','browser_application')),\n owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(trim(owner_id)) BETWEEN 1 AND 200 AND owner_id GLOB '[a-zA-Z0-9_-]*' AND owner_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n owner_scope_json TEXT NOT NULL CHECK(CASE WHEN json_valid(owner_scope_json) THEN json_type(owner_scope_json)='object' AND length(CAST(owner_scope_json AS BLOB))<=65536 ELSE 0 END),\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n provider_id TEXT NOT NULL REFERENCES provider_settings(id),\n model_id TEXT NOT NULL CHECK(typeof(model_id)='text' AND length(trim(model_id)) BETWEEN 1 AND 500),\n contract_version TEXT NOT NULL CHECK(typeof(contract_version)='text' AND length(trim(contract_version)) BETWEEN 1 AND 200),\n tool_policy_version TEXT NOT NULL CHECK(typeof(tool_policy_version)='text' AND length(trim(tool_policy_version)) BETWEEN 1 AND 200),\n knowledge_hash TEXT NOT NULL CHECK(length(knowledge_hash)=64 AND knowledge_hash NOT GLOB '*[^0-9a-f]*'),\n native_ref_json TEXT CHECK(native_ref_json IS NULL OR (CASE WHEN json_valid(native_ref_json) THEN json_type(native_ref_json)='object' AND length(CAST(native_ref_json AS BLOB))<=65536 ELSE 0 END)),\n native_ref_version INTEGER CHECK(native_ref_version IS NULL OR (typeof(native_ref_version)='integer' AND native_ref_version BETWEEN 1 AND 9007199254740991)),\n provider_fingerprint TEXT CHECK(provider_fingerprint IS NULL OR (length(provider_fingerprint)=64 AND provider_fingerprint NOT GLOB '*[^0-9a-f]*')),\n generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleting','deleted')),\n native_delete_state TEXT NOT NULL CHECK(native_delete_state IN ('present','pending','unknown','absent')),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n UNIQUE(id,mode),\n CHECK((scenario='workflow' AND owner_kind='workflow_draft') OR (scenario='script' AND owner_kind='script_draft') OR (scenario='web-bridge' AND owner_kind='browser_application')),\n CHECK((native_ref_json IS NULL AND native_ref_version IS NULL AND provider_fingerprint IS NULL) OR (native_ref_json IS NOT NULL AND native_ref_version IS NOT NULL AND provider_fingerprint IS NOT NULL)),\n CHECK(mode!='single' OR (native_ref_json IS NULL AND native_delete_state='absent')),\n CHECK(native_delete_state!='absent' OR native_ref_json IS NULL),\n CHECK(native_delete_state!='present' OR native_ref_json IS NOT NULL),\n CHECK(lifecycle!='deleted' OR (native_delete_state='absent' AND native_ref_json IS NULL))\n)"
      },
      {
        "type": "table",
        "name": "agent_maintenance_tasks",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE TABLE agent_maintenance_tasks (\n id TEXT NOT NULL PRIMARY KEY CHECK(typeof(id)='text' AND length(trim(id)) BETWEEN 1 AND 200),\n session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,\n mode TEXT NOT NULL CHECK(mode IN ('single','multi')),\n request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(trim(request_id)) BETWEEN 1 AND 200),\n request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),\n sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),\n generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),\n projection_generation INTEGER NOT NULL CHECK(typeof(projection_generation)='integer' AND projection_generation BETWEEN 1 AND 9007199254740991),\n projection_hash TEXT NOT NULL CHECK(length(projection_hash)=64 AND projection_hash NOT GLOB '*[^0-9a-f]*'),\n baseline_json TEXT NOT NULL CHECK(CASE WHEN json_valid(baseline_json) THEN json_type(baseline_json)='object' AND length(CAST(baseline_json AS BLOB))<=65536 ELSE 0 END),\n status TEXT NOT NULL CHECK(status IN ('queued','running','stopping','succeeded','failed','cancelled','interrupted')),\n process_state TEXT NOT NULL CHECK(process_state IN ('absent','starting','running','stopping','stopped','unknown')),\n input_ref TEXT CHECK(input_ref IS NULL OR (CASE WHEN json_valid(input_ref) THEN json_type(input_ref)='object' AND length(CAST(input_ref AS BLOB))<=65536 ELSE 0 END)),\n display_output_ref TEXT CHECK(display_output_ref IS NULL OR (CASE WHEN json_valid(display_output_ref) THEN json_type(display_output_ref)='object' AND length(CAST(display_output_ref AS BLOB))<=65536 ELSE 0 END)),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),\n started_at INTEGER CHECK(started_at IS NULL OR (typeof(started_at)='integer' AND started_at BETWEEN 0 AND 9007199254740991)),\n ended_at INTEGER CHECK(ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN 0 AND 9007199254740991)),\n UNIQUE(id,session_id), UNIQUE(session_id,request_id), UNIQUE(session_id,sequence),\n FOREIGN KEY(session_id,mode) REFERENCES agent_maintenance_sessions(id,mode),\n CHECK(mode!='single' OR sequence=1),\n CHECK(status IN ('queued','running','stopping') OR (process_state IN ('absent','stopped') AND ended_at IS NOT NULL))\n)"
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
        "name": "agent_workspace_projection_state",
        "tbl_name": "agent_workspace_projection_state",
        "sql": "CREATE TABLE agent_workspace_projection_state (\n id TEXT NOT NULL PRIMARY KEY CHECK(id='maintenance'),\n target_generation INTEGER NOT NULL CHECK(typeof(target_generation)='integer' AND target_generation BETWEEN 1 AND 9007199254740991),\n synced_generation INTEGER NOT NULL CHECK(typeof(synced_generation)='integer' AND synced_generation BETWEEN 0 AND 9007199254740991 AND synced_generation<=target_generation),\n target_knowledge_hash TEXT NOT NULL CHECK(length(target_knowledge_hash)=64 AND target_knowledge_hash NOT GLOB '*[^0-9a-f]*'),\n synced_knowledge_hash TEXT CHECK(synced_knowledge_hash IS NULL OR (length(synced_knowledge_hash)=64 AND synced_knowledge_hash NOT GLOB '*[^0-9a-f]*')),\n content_hash TEXT CHECK(content_hash IS NULL OR (length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*')),\n state TEXT NOT NULL CHECK(state IN ('pending','syncing','ready','failed')),\n error_code TEXT CHECK(error_code IS NULL OR (typeof(error_code)='text' AND length(trim(error_code)) BETWEEN 1 AND 200)),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),\n CHECK(state!='ready' OR (target_generation=synced_generation AND synced_knowledge_hash IS NOT NULL AND synced_knowledge_hash=target_knowledge_hash AND content_hash IS NOT NULL))\n)"
      },
      {
        "type": "table",
        "name": "agent_workspace_workflow_bindings",
        "tbl_name": "agent_workspace_workflow_bindings",
        "sql": "CREATE TABLE agent_workspace_workflow_bindings (\n draft_id TEXT NOT NULL PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,\n resource_id TEXT NOT NULL CHECK(typeof(resource_id)='text' AND length(trim(resource_id)) BETWEEN 1 AND 200 AND resource_id GLOB '[a-zA-Z0-9_-]*' AND resource_id NOT GLOB '*[^a-zA-Z0-9_.-]*'),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991)\n)"
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
        "name": "bridge_configuration",
        "tbl_name": "bridge_configuration",
        "sql": "CREATE TABLE bridge_configuration (\n id TEXT NOT NULL PRIMARY KEY CHECK(id='current'),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n config_json TEXT NOT NULL CHECK(CASE WHEN json_valid(config_json) THEN json_type(config_json)='object' AND length(CAST(config_json AS BLOB))<=16777216 ELSE 0 END),\n content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991)\n)"
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
        "name": "agent_maintenance_apply_requests_identity_immutable",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE TRIGGER agent_maintenance_apply_requests_identity_immutable BEFORE UPDATE ON agent_maintenance_apply_requests\nWHEN NEW.id IS NOT OLD.id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.confirmation_id IS NOT OLD.confirmation_id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_apply_requests_no_replace",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE TRIGGER agent_maintenance_apply_requests_no_replace BEFORE INSERT ON agent_maintenance_apply_requests\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_apply_requests_result_immutable",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE TRIGGER agent_maintenance_apply_requests_result_immutable BEFORE UPDATE ON agent_maintenance_apply_requests\nWHEN OLD.state!='queued'\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_RESULT_IMMUTABLE'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_decisions_decision_immutable",
        "tbl_name": "agent_maintenance_decisions",
        "sql": "CREATE TRIGGER agent_maintenance_decisions_decision_immutable BEFORE UPDATE ON agent_maintenance_decisions\nWHEN 1\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_IMMUTABLE'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_decisions_no_replace",
        "tbl_name": "agent_maintenance_decisions",
        "sql": "CREATE TRIGGER agent_maintenance_decisions_no_replace BEFORE INSERT ON agent_maintenance_decisions\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id) OR (proposal_id=NEW.proposal_id AND action=NEW.action))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_proposals_content_immutable",
        "tbl_name": "agent_maintenance_proposals",
        "sql": "CREATE TRIGGER agent_maintenance_proposals_content_immutable BEFORE UPDATE ON agent_maintenance_proposals\nWHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.session_id IS NOT OLD.session_id OR NEW.task_id IS NOT OLD.task_id OR NEW.submit_request_id IS NOT OLD.submit_request_id OR NEW.submit_request_hash IS NOT OLD.submit_request_hash OR NEW.contract_version IS NOT OLD.contract_version OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_id IS NOT OLD.target_id OR NEW.target_scope_json IS NOT OLD.target_scope_json OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.body_json IS NOT OLD.body_json OR NEW.before_json IS NOT OLD.before_json OR NEW.content_hash IS NOT OLD.content_hash OR NEW.diff_hash IS NOT OLD.diff_hash OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONTENT_IMMUTABLE'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_proposals_no_replace",
        "tbl_name": "agent_maintenance_proposals",
        "sql": "CREATE TRIGGER agent_maintenance_proposals_no_replace BEFORE INSERT ON agent_maintenance_proposals\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_proposals WHERE id=NEW.id OR (actor_key=NEW.actor_key AND submit_request_id=NEW.submit_request_id))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_sessions_generation_monotonic",
        "tbl_name": "agent_maintenance_sessions",
        "sql": "CREATE TRIGGER agent_maintenance_sessions_generation_monotonic BEFORE UPDATE ON agent_maintenance_sessions\nWHEN NEW.generation<OLD.generation OR NEW.revision<OLD.revision\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_sessions_identity_immutable",
        "tbl_name": "agent_maintenance_sessions",
        "sql": "CREATE TRIGGER agent_maintenance_sessions_identity_immutable BEFORE UPDATE ON agent_maintenance_sessions\nWHEN NEW.id IS NOT OLD.id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.scenario IS NOT OLD.scenario OR NEW.owner_kind IS NOT OLD.owner_kind OR NEW.owner_id IS NOT OLD.owner_id OR NEW.owner_scope_json IS NOT OLD.owner_scope_json OR NEW.mode IS NOT OLD.mode OR NEW.provider_id IS NOT OLD.provider_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.tool_policy_version IS NOT OLD.tool_policy_version OR NEW.knowledge_hash IS NOT OLD.knowledge_hash OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_sessions_no_replace",
        "tbl_name": "agent_maintenance_sessions",
        "sql": "CREATE TRIGGER agent_maintenance_sessions_no_replace BEFORE INSERT ON agent_maintenance_sessions\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_sessions WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_tasks_identity_immutable",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE TRIGGER agent_maintenance_tasks_identity_immutable BEFORE UPDATE ON agent_maintenance_tasks\nWHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.mode IS NOT OLD.mode OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.sequence IS NOT OLD.sequence OR NEW.generation IS NOT OLD.generation OR NEW.projection_generation IS NOT OLD.projection_generation OR NEW.projection_hash IS NOT OLD.projection_hash OR NEW.baseline_json IS NOT OLD.baseline_json OR NEW.input_ref IS NOT OLD.input_ref OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END"
      },
      {
        "type": "trigger",
        "name": "agent_maintenance_tasks_no_replace",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE TRIGGER agent_maintenance_tasks_no_replace BEFORE INSERT ON agent_maintenance_tasks\nWHEN EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE id=NEW.id OR (session_id=NEW.session_id AND (request_id=NEW.request_id OR sequence=NEW.sequence OR (mode='single' AND NEW.mode='single'))) OR (NEW.status IN ('queued','running','stopping') AND status IN ('queued','running','stopping')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "agent_workspace_projection_state_generation_monotonic",
        "tbl_name": "agent_workspace_projection_state",
        "sql": "CREATE TRIGGER agent_workspace_projection_state_generation_monotonic BEFORE UPDATE ON agent_workspace_projection_state\nWHEN NEW.id IS NOT OLD.id OR NEW.target_generation<OLD.target_generation OR NEW.synced_generation<OLD.synced_generation\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_GENERATION_MONOTONIC'); END"
      },
      {
        "type": "trigger",
        "name": "agent_workspace_projection_state_no_replace",
        "tbl_name": "agent_workspace_projection_state",
        "sql": "CREATE TRIGGER agent_workspace_projection_state_no_replace BEFORE INSERT ON agent_workspace_projection_state\nWHEN EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "agent_workspace_workflow_bindings_identity_immutable",
        "tbl_name": "agent_workspace_workflow_bindings",
        "sql": "CREATE TRIGGER agent_workspace_workflow_bindings_identity_immutable BEFORE UPDATE ON agent_workspace_workflow_bindings\nWHEN NEW.draft_id IS NOT OLD.draft_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.created_at IS NOT OLD.created_at\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_IDENTITY_IMMUTABLE'); END"
      },
      {
        "type": "trigger",
        "name": "agent_workspace_workflow_bindings_no_replace",
        "tbl_name": "agent_workspace_workflow_bindings",
        "sql": "CREATE TRIGGER agent_workspace_workflow_bindings_no_replace BEFORE INSERT ON agent_workspace_workflow_bindings\nWHEN EXISTS(SELECT 1 FROM agent_workspace_workflow_bindings WHERE draft_id=NEW.draft_id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "bridge_configuration_no_replace",
        "tbl_name": "bridge_configuration",
        "sql": "CREATE TRIGGER bridge_configuration_no_replace BEFORE INSERT ON bridge_configuration\nWHEN EXISTS(SELECT 1 FROM bridge_configuration WHERE id=NEW.id)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END"
      },
      {
        "type": "trigger",
        "name": "bridge_configuration_revision_monotonic",
        "tbl_name": "bridge_configuration",
        "sql": "CREATE TRIGGER bridge_configuration_revision_monotonic BEFORE UPDATE ON bridge_configuration\nWHEN NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_REVISION_MONOTONIC'); END"
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
        "name": "maintenance_apply_commit",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE TRIGGER maintenance_apply_commit BEFORE UPDATE OF state ON agent_maintenance_apply_requests\nWHEN NEW.state='applied' AND (\n EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping'))\n OR NOT EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id='maintenance' AND target_generation=NEW.target_generation AND state IN ('pending','syncing'))\n OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id\n WHERE d.id=NEW.confirmation_id AND p.id=NEW.proposal_id AND d.action='confirm' AND p.state='confirmed'\n AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash\n AND d.valid_until>NEW.updated_at AND p.expires_at>NEW.updated_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_APPLY_BLOCKED'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_apply_confirmation",
        "tbl_name": "agent_maintenance_apply_requests",
        "sql": "CREATE TRIGGER maintenance_apply_confirmation BEFORE INSERT ON agent_maintenance_apply_requests\nWHEN NEW.state='applied' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id\n WHERE d.id=NEW.confirmation_id AND d.proposal_id=NEW.proposal_id AND d.action='confirm'\n AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash\n AND (NEW.state!='queued' OR (p.state='confirmed' AND d.valid_until>NEW.created_at AND p.expires_at>NEW.created_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_CONFIRMATION_REQUIRED'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_decision_binding",
        "tbl_name": "agent_maintenance_decisions",
        "sql": "CREATE TRIGGER maintenance_decision_binding BEFORE INSERT ON agent_maintenance_decisions\nWHEN NOT EXISTS(SELECT 1 FROM agent_maintenance_proposals p WHERE p.id=NEW.proposal_id\n AND p.actor_key=NEW.actor_key AND p.content_hash=NEW.content_hash AND p.diff_hash=NEW.diff_hash\n AND NEW.created_at>=p.created_at AND NEW.created_at<p.expires_at\n AND ((NEW.action='confirm' AND p.state='pending' AND NEW.valid_until<=p.expires_at\n AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke'))\n OR (NEW.action='revoke' AND p.state IN ('pending','confirmed'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DECISION_BINDING'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_proposal_owner",
        "tbl_name": "agent_maintenance_proposals",
        "sql": "CREATE TRIGGER maintenance_proposal_owner BEFORE INSERT ON agent_maintenance_proposals\nWHEN NEW.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_sessions s JOIN agent_maintenance_tasks t ON t.session_id=s.id\n WHERE s.id=NEW.session_id AND t.id=NEW.task_id AND s.actor_key=NEW.actor_key\n AND s.owner_kind=NEW.target_kind AND s.owner_id=NEW.target_id\n AND s.owner_scope_json=NEW.target_scope_json AND s.contract_version=NEW.contract_version\n AND t.baseline_json=NEW.baseline_json)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_OWNER'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_proposal_state",
        "tbl_name": "agent_maintenance_proposals",
        "sql": "CREATE TRIGGER maintenance_proposal_state BEFORE UPDATE OF state ON agent_maintenance_proposals\nWHEN NEW.state IS NOT OLD.state AND (\n OLD.state NOT IN ('pending','confirmed') OR NEW.state='pending'\n OR (NEW.state='confirmed' AND (OLD.state!='pending' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='confirm') OR EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke')))\n OR (NEW.state='revoked' AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions WHERE proposal_id=OLD.id AND action='revoke'))\n OR (NEW.state='applied' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='applied')))\n OR (NEW.state='conflicted' AND (OLD.state!='confirmed' OR NOT EXISTS(SELECT 1 FROM agent_maintenance_apply_requests WHERE proposal_id=OLD.id AND state='conflicted'))))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_PROPOSAL_STATE'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_session_delete",
        "tbl_name": "agent_maintenance_sessions",
        "sql": "CREATE TRIGGER maintenance_session_delete BEFORE DELETE ON agent_maintenance_sessions\nWHEN OLD.lifecycle!='deleted' OR OLD.native_delete_state!='absent'\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_DELETE_UNCONFIRMED'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_session_lifecycle",
        "tbl_name": "agent_maintenance_sessions",
        "sql": "CREATE TRIGGER maintenance_session_lifecycle BEFORE UPDATE OF lifecycle ON agent_maintenance_sessions\nWHEN (OLD.lifecycle='deleted' AND NEW.lifecycle!='deleted')\n OR (OLD.lifecycle='deleting' AND NEW.lifecycle='active')\n OR (NEW.lifecycle!='active' AND EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE session_id=OLD.id AND status IN ('queued','running','stopping')))\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_SESSION_BUSY'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_task_admission",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE TRIGGER maintenance_task_admission BEFORE INSERT ON agent_maintenance_tasks\nWHEN NEW.status IN ('queued','running','stopping') AND NOT EXISTS(\n SELECT 1 FROM agent_maintenance_sessions s,agent_workspace_projection_state p\n WHERE s.id=NEW.session_id AND s.lifecycle='active' AND s.native_delete_state IN ('present','absent') AND s.generation=NEW.generation\n AND p.id='maintenance' AND p.state='ready' AND p.synced_generation=NEW.projection_generation\n AND p.content_hash=NEW.projection_hash AND p.target_knowledge_hash=s.knowledge_hash)\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_BLOCKED'); END"
      },
      {
        "type": "trigger",
        "name": "maintenance_task_no_reopen",
        "tbl_name": "agent_maintenance_tasks",
        "sql": "CREATE TRIGGER maintenance_task_no_reopen BEFORE UPDATE OF status ON agent_maintenance_tasks\nWHEN OLD.status NOT IN ('queued','running','stopping') AND NEW.status IS NOT OLD.status\nBEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_SETTLED'); END"
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
    "id": "db.workspace-projection.v10-v11",
    "kind": "database",
    "from": 10,
    "to": 11,
    "requires": [
      "db.v9-v10"
    ],
    "checksum": "376ad66809a96cfccfdec843f4d3c962e4af4b509b31570f5bd54f9b537a31fe",
    "summary": "迁入浏览器声明并建立工作流草稿绑定和维护工作区",
    "affectedResources": [
      "workbench.db",
      "config/web-bridge.json"
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
export const approval = {"status":"approved","reviewer":"用户","date":"2026-11-12","contentDigest":"54c0a5fcb883887e0b5afec8a84a991a6cdec7339a36631f671bbb8a90dc9645"};
export const releaseDigest = "6f758fbb750752e53e1bab4830c99a8134c62eb75fa6654067416fc627802367";
export const manifestChecksum = "1588d5e64d7828976764b2d7eefc61504204757d304c61800f1860a600a453c5";
export const releaseFiles: Record<string,string> = {
  "docs/features/2026-11-06-data-migration/execution-protocol.md": "d19242b2745323f1b2d76a23eab5118a990612d02fb6286ccac802632457f67e",
  "docs/features/2026-11-06-data-migration/release-v10.json": "a28280a0d5647ef4316b80b6788c4bdb62723029cff1d6194fef43346060c4bc",
  "docs/features/2026-11-06-data-migration/release-v6.json": "e3560640299e3d0da4b5c5fa6d15c1a29abd9ad15a976b4cf16467bd6a236b8c",
  "docs/features/2026-11-06-data-migration/release-v9.json": "5cbab7bd1091dc2b2b8b987d316d3b9144dbe9ddd32c124af61b4918be1a9ff6",
  "docs/features/2026-11-06-data-migration/schema-approval-v8.json": "598a716d8e7fd04ef5a480254e3f512be5a1095336ddcc9428e3dba8e8c9e604",
  "docs/features/2026-11-06-data-migration/schema-approval.json": "58cbfca6bc7edac4a2a6d3f69d2ccd030241218dbdfc93c05811bc8d845dd099",
  "docs/features/2026-11-06-data-migration/schema-review.md": "d455fb7a86371ceb09b195933c49453db9dee2d7bb932572220aac8c827785b0",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v10.sql": "f4d81ddb90de6bc956febee35d082e2dcd7a837001f234068f36f1d798bc6ffa",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v11.sql": "5973ced56dec4f3d5cb62cf559ca5fc225974621990c0e4d87aafd4e6ad8ba9b",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v6.sql": "caa959c5e00a3c70bdd8f5814f28e4c8e7a20697d6c4d74ac14a58d549f2de71",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v8.sql": "d780513fe40fbd1a52dbf349d93ac747b110e64d9fd0e30f2e9882fce0eaf6b8",
  "docs/features/2026-11-06-data-migration/sql/db.initialize-v9.sql": "bb6f015ac35ac532174871e9acda0fd7eec504fe0e9836c3984e7da2e0245c34",
  "docs/features/2026-11-06-data-migration/sql/db.v1-v2.sql": "4e9f79c33a3cef4ec6dc51a299fb11d6cf8736ffb511d0e0f1ffe18c99954a87",
  "docs/features/2026-11-06-data-migration/sql/db.v10-v11.sql": "486dcb274dc83f889d3c83eadc9f1cbc4a1accc7f408f76316fa8781c726f8d2",
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
  "docs/features/2026-11-09-dictionaries/schema-review-v10.md": "d901e418af4045bff4eee5487f8ea837451db8031abcb46a651a04bafdacfa38",
  "docs/features/2026-11-09-dictionaries/schema-review-v9.md": "6b874c8b082ec71645ed2bc50a6ede9387f446a7b11c84df0169873b6cd569a9",
  "docs/features/2026-11-12-agent-workspace-projection/database-review-approved.md": "53aff92377491568ee91452358afb28f3254c75d3782909f7381c4d2b7515074",
  "docs/features/2026-11-12-agent-workspace-projection/migration-release-review.md": "dabcadb36345442ed2c7ded3821856634d264c24990dfa55f1c6247e31198859",
  "docs/features/2026-11-12-agent-workspace-projection/schema-approval-v11.json": "0a5fe2779f9df48fe2263a11f04165f7decf06cf0d64ead69f1a2cde6eea5506",
  "index.html": "2ccf341b5cae427d99b57d4bdbfb30f4d7bf07983b73ef53f358febaf0444f10",
  "package.json": "aedfb77e7731245c4fbd9212d207534904b1b1c4629f4df12e49e7720f580bb4",
  "pnpm-lock.yaml": "167b41ca739ec3292214819d9a62db085b8a9963a88afd6b4bc9a994c8cc643d",
  "scripts/agent-knowledge.mts": "bb1d33ba505a4dfd7ac4213fab6a8862025eea1dc41182f04ac36f174d2e234a",
  "scripts/check-migration-manifest.mjs": "82eee6deb5079cbb4ff853627dce8571fec6d806e44ef16ca3a401c8d9de4389",
  "scripts/create-migration-integrity.mjs": "2cab61886a21ad9fc401c3cbe7825f3c13d67c00ad96c67358f6f94428accd5c",
  "scripts/dev.mjs": "ccb2207256ae2268a157f05f08f9e3f084eeb06515cc11e6c4a1206507cbfe38",
  "scripts/generate-migration-bundle.mjs": "2f5af42776ba024f4525b150f50f2550f9329b47b393fbd8afee2c0916284679",
  "scripts/lock-migration-release.mjs": "8053a4cf5ced27efde01407ebc611b36f03a22eab0e3c9e5f7311173facdef37",
  "scripts/probe-workspace-cli.mjs": "decd2f900165e26d7189c0794807b64330bee57ea0098431f1084b7ca0497cfd",
  "scripts/probe-workspace-reader.mts": "c7cb543ddafb37ea55365f63532d047a95ded98fda78f8dc1ef6ce2dc8f55d55",
  "src/agent/asset-query-host.ts": "e9c424eed4f2997875dbef8295e492c9b9fbf7ea4f1bdac73e15b7932d159962",
  "src/agent/control.ts": "8d62541b85208abc5317210575ffb1aac3dd4e186912356df4ddb852a4c996b1",
  "src/agent/feedback.ts": "1c19bb64dba1dc3629c4877b69eeb67d0e1a8caeb66e504f92395c2cc1e559aa",
  "src/agent/knowledge-bundle.ts": "9f0c83b718e7a29b25c6055d9717128dead9939c5a279ceb202f31f48242fdbb",
  "src/agent/knowledge-service.ts": "34559e7e1a81fa64dacba829a2ab118161506b0107880abb7a7c03b1999c0797",
  "src/agent/knowledge-store.ts": "77d37f8abb143cac9065fa207ce14169766f59c1797369b1905e23700a8ebdda",
  "src/agent/knowledge/.agents/mcp.json": "56b1182dafa1eb9b572bafd8ec3a858ec4823927cd4929a8d42b0de0386128de",
  "src/agent/knowledge/.agents/skills/script-authoring/SKILL.md": "f9e13ad19ad19d99db26562bef5af85329552fc47c2569019060c030aa9d7cf2",
  "src/agent/knowledge/.agents/skills/web-bridge-authoring/SKILL.md": "509f71699073c6e08ed2828502574cb056977ce3440f47713a9f0de484ca95d9",
  "src/agent/knowledge/.agents/skills/workflow-authoring/SKILL.md": "b0d267878d37890f441b5eb038f8bef4ba71f56bfabeaf334a1485fce6e72b74",
  "src/agent/knowledge/AGENTS.md": "b5eca3485fc33348ecf94e0f6e144713d5d670bd1d2d42b160e5c9cdcde8793c",
  "src/agent/knowledge/docs/script.md": "553420bb37feacebe28decbf8434359e1a4dbf8e47acb6f4f6b34a59930b7660",
  "src/agent/knowledge/docs/web-bridge.md": "6cb461a53668ec5c42aca46ac4b1c33658e237adc10e126c6c7948864bdf14c5",
  "src/agent/knowledge/docs/workflow.md": "8b90b68eb28bc00d3d21830ca8766ac261c27423d2c665713bc6e83fe42f078f",
  "src/agent/knowledge/manifest.json": "914c2dca75aea1576d2a5d3760eb267a89d25aeede418f736cfad22d74a02516",
  "src/agent/legacy-reset.ts": "afc3949a416d49d9ae9691658c8ea3fb3b255392872a67b3dca4aa9ad56a4537",
  "src/agent/locks.ts": "ccdcf3302e61e5518ab1bdc76d498fd2639ffc24b9df4b5881fe7ce401df9189",
  "src/agent/maintenance-assets.ts": "423b590c8f3b9624686a8fc629e8744f7d2e396ae6e64c5d52f7d0b12c3f0fda",
  "src/agent/maintenance-composition.ts": "ac17cf0333ddecd093f2a8d3af511f5accf647bbf7b0fb4ec15f69b7aa2482e6",
  "src/agent/maintenance-file-protocol.ts": "f42b40ffdbd2b1a67716df6b296182254cf21c73fd5dc5c8be715504344d782a",
  "src/agent/maintenance-ipc-client.ts": "81dcdd269f6d39c4bc382492928ae2d59a85d8addcdc30fb48a7602719a7a098",
  "src/agent/maintenance-ipc-wire.ts": "d9b03f1508f1dff698f8f149e6f9f2f5f1c68fc8f1fdce0052264992753c9ae8",
  "src/agent/maintenance-ipc.ts": "a645ec8f3b8e939dbd631e79edae806a54c9525d2adee735b81bfff062493849",
  "src/agent/maintenance-mcp-client.ts": "89d6fe8492cb22beaeb7635d56775b96f5b65d2a460d696e070cb51a6a7fa7e9",
  "src/agent/maintenance-mcp-stdio.ts": "04f55688256ada45cad3416e8dac4eabdb02d3f57cc66d5aded2d3d9bf09642e",
  "src/agent/maintenance-pi-backend.ts": "91318481a030247a27222bb8eeb5358d37c5233c7dec54df845ce00210e94bf7",
  "src/agent/maintenance-pi-extension.ts": "0d386d3fae87470df37a088ee1ab04f75ac38fa30becef656d0960945a58a070",
  "src/agent/maintenance-pi-launcher.ts": "fd2f14e639b24367974a1ac16b95df35750c8ff96b6ab6a456017e9160ff30be",
  "src/agent/maintenance-pi-tools.ts": "76f5b11a382786b3d6814296dcd7698b6aa062dd67b4e6839fd124717932dc33",
  "src/agent/maintenance-processes.ts": "666b4be5d2ef765ca072e982ddf9616882f4c7bc482815f7537d869e5dba3d17",
  "src/agent/maintenance-production.ts": "cce76a52a30b71bdad14ace4191737edd5566bc3cc196ae248046b0df15fd6b9",
  "src/agent/maintenance-protocol.ts": "3b257218fb3633a40ee59cb86eb72bb305edb9220053a0a5ee3308cf75857769",
  "src/agent/maintenance-routes.ts": "c565923e0f8beadcc5ae1ad3d86b356b5a40cc50da28bbeb248faf4b1148b20b",
  "src/agent/maintenance-service.ts": "f99590c23b6068e5277243510146afa004d93d19460a9c2bc59e51d98410a858",
  "src/agent/maintenance-sessions.ts": "e75965dae8b60be2cda9af4f6ad871f77d6a7ff120bf6f0b5f4345379d5f1734",
  "src/agent/maintenance-stop-journal.ts": "2e62df0855945f9268e6809b7206645702f7ba2111acaab89fddb60bcab7d34d",
  "src/agent/maintenance-task-host.ts": "0ddac57336d9ae0109ff973568b34714ce85b5e0ba52ecc146c99bb99ef052ba",
  "src/agent/maintenance-tools.ts": "20436b69c8caba2efd72004c406a43378e7b2d01c58fa01d5de238042cab7177",
  "src/agent/maintenance-worker.ts": "1104b3660d00d0a22b0f7e9d92bafaa9008edc854fdaed60df878f3b1bb4aa6a",
  "src/agent/model-control.ts": "520b53d6b9550a0e7384e32e697c01334aec55498ab749b7e9147b55f03caf82",
  "src/agent/multi-provider-host.ts": "11b5eac6c81523ad845458a9a2c32777844d93ddc420101098be503c7505c298",
  "src/agent/native-multi-provider.ts": "c05ab28ac952196c54ca1342f24c46c38c06e7d257ebcf5820cd455af0345ec6",
  "src/agent/provider-contract.ts": "e28fe5862c4f4fb5ddbb5903870cd67fb3413a37b38f51281a2a8b9602ae8e54",
  "src/agent/query-gateway.ts": "9a8a8a871304f5e7ddc5ccd4c033fa159a8d612c949e86db290adb1af33dd705",
  "src/agent/reset-preview.ts": "bf48ab8d6c6c056b97803763574465607dc2bea5831f491a9eeb9156f1f2109b",
  "src/agent/runtime.ts": "f2010d825d2fcdec5b19924d8a1a5611b4d94ca43ce0cde2946b0d4f8731a030",
  "src/agent/schema.ts": "edf2b5c3e65b71d65bbd7627df878defe1b4d7dc1faf2adabe08a87d34da7d52",
  "src/agent/session-lifecycle-guard.ts": "f4a2b6dd4987e9acf3fafcd2a0f4ba3bd9040ebc767a086d2d5cabff5823c344",
  "src/agent/settings.ts": "6c7afc394d7dc1c8563cb6c2955416e1fdae16ce45d4f50c7a2eec2938ecffe1",
  "src/agent/single-provider-host.ts": "18c2173686104b9b170d2a038c739e7c24e3a01fdb28f08bdb7a6abd2c13583f",
  "src/agent/store.ts": "a8a5ac0e0bab39d7bd2fe2502bd461ed06d012e07ef9f3c5d87c31414e7b8d4a",
  "src/agent/workspace-business-hooks.ts": "523d23414a51566672df81badb32b7124d19f77861670a04969cb297897a2772",
  "src/agent/workspace-dependencies.ts": "a1fba37f2d675779b0235794e87a4f672ab432617c769a9184e085461ec5a1f0",
  "src/agent/workspace-files.ts": "5b9e62f7a722339e6f16c92eb5a913e2fe99b7ea48176872ccf46c3585a4e878",
  "src/agent/workspace-identity.ts": "1f1ceb9443bfdb4233707ca31c6a1b5769f2e66dfd268f7737b643af58dc11e9",
  "src/agent/workspace-installer.ts": "a77017fdea2e4c4afd396ca5fec034deade29d1439a1a03a0a1254d90896db02",
  "src/agent/workspace-migration-preview.ts": "519e8e087711e24b7f3d8f3825eb820a9f95a9b35c2f5883eaf87d0dd9e18d2c",
  "src/agent/workspace-projection-source.ts": "995844dd0a4baba7684a16e4b4bd0ad4a70abdd7b0d3d2e12883663265566c38",
  "src/agent/workspace-projection.ts": "6b973093706c824f0b95bb56e0129062ff2c3784eb0d82e6465853f5afd02e80",
  "src/agent/workspace-schema.ts": "e9866e81b604b58fa751f450c2b41d838d2dd5f07e543e8db36265c01399d151",
  "src/agent/workspace-state.ts": "61a783f53afc96e37a0c881a54e17558f91020357af269cf70680d453970f872",
  "src/authoring/agent-model-configs.ts": "76654c4197a26979fa7c002d1e92e9e4ee97bff75e76f4ff830ff7419b1a7b85",
  "src/authoring/context.ts": "d962e5ffab3daa8b02742aa9c986e9e880998d1f1f958cb7b7a7466c7596dc84",
  "src/authoring/conversations.ts": "b01415085b340f87e0b6354c6004f06ac35b1ddb7b8ecbb0afc961c09399a406",
  "src/authoring/default-prompts.ts": "199132f4d82f36d664b905b48b4c2b97940087d74655931640b90da4576829cb",
  "src/authoring/prompt-preview.ts": "34ab2969981365912a0cc8af2990499b17debb675517d4228867211082879fbc",
  "src/authoring/resources.ts": "493bd0c3ee80676684037e140928117925b69c303dc9cabe7e54ff2d092d8fdf",
  "src/authoring/schema.ts": "90a216c8554614920036d3f8df1a759f2678c2ad3640cfc93305707461f6c7f3",
  "src/authoring/script-agent-prompt.ts": "6a6ea6cfa1dc00645fce32f4032268bbf9655599fcca0929cf805d87525e591e",
  "src/authoring/script-agent.ts": "1b3b183f634271b2ca105c2453b6710141529c675fd0ee588189fd54b1d4a30b",
  "src/authoring/script-library.ts": "e5b12e08ec3157d5fb56a9c332b6ae78f302c22fd33dc2cefad45b04e297c534",
  "src/authoring/service.ts": "86731c8dd5ac39346e7ccbbf00074224917466717a759f095719ebfad2e1dcc6",
  "src/cli/index.ts": "0cdbedb6cf6ef2376abb877ca9f585833ebfaae5b7a34f35eb08c8002f2c64da",
  "src/config-git/cli.ts": "551d7916360d850e9b28fd3df261e5f8f79f88a48bc82307781b5e87e2d65bc6",
  "src/config-git/coordinator.ts": "53622574e8629f3d7c1a96babe0e6eff50cb25eab5645c1bd59acb472686342d",
  "src/config-git/dictionaries.ts": "bda007857986a11d650bbc9a7b69334cdce32c88fc7fef3fc4e18962b3042f4a",
  "src/config-git/operations.ts": "63340513d6b9ff31356fc93e6743ce3fbcfb256882967c1e587663f4670ab098",
  "src/config-git/repository.ts": "27ef26433cc6f22f73418db4a946ca3cddf27292edabc1cd406192aa458d35ae",
  "src/config-git/restore-files.ts": "48cf1ed79339e6ef5d70b14207c6f08d575c6f1060d2f1c48fc23b16124b1d1f",
  "src/config-git/restore-import.ts": "13dad152ca9073fab33adbe78cfc0cedc3b382b099fafd453eb3acc94a24bc32",
  "src/config-git/restore.ts": "6c6e8aaa0ddb9daee64b834b6a6f00cae5f535d4badaee825f7474c4b04f0cbb",
  "src/config-git/routes.ts": "8394df19de6220bb31c91ce047a3b1f08f281b578522bde0e07d5c9f87884600",
  "src/config-git/service.ts": "badd4717d4e71b6f0523d49fcfe92810aaae7712828f6dc820058303e71674b1",
  "src/config-git/snapshot-primitives.ts": "17f52d9a786a927d19b28fa60cd6de8e69e8e1f38182b4107dca0758fc30ccbb",
  "src/config-git/snapshot-types.ts": "b1238a7d0a5aef197d7554297bbdeaa1076e656dc1653ef6ce39b6b9c2a025c2",
  "src/config-git/snapshot-validation.ts": "dc2507fd14034d0dd458ba7d33295beb659a885e4ea376e0f47cbe06f5c56bb0",
  "src/config-git/snapshot.ts": "42509799eb2e8b566a1e995fa76b60ad5002b85297026894e94f45dffd522413",
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
  "src/migrations/definitions.ts": "f8d2dfe5c80988035de5aca068d6a4c183a0a094216a8b164fa3aa2760c6d565",
  "src/migrations/journal.ts": "cfa41b539c32b6b4c39ee8d60394194c9ace4ffb88d5511c326442e463bc606b",
  "src/migrations/lock.ts": "63f6818b13aee27350e6961dbd6efbf52924477f0c37834aedbd516035b04ac5",
  "src/migrations/mapping.ts": "a965c49ed17b74caf27b923647c3a7ae471024c9c1c414ca9ad7be4bd0adc54e",
  "src/migrations/planner.ts": "95a8d5593e6fd517b673dbcb85d52797814037e0801da42507d6a495bd38cd0d",
  "src/migrations/preview.ts": "130c7eb237a0297ad7c159334e847349d6e441607af9be95b4f396de0853143e",
  "src/migrations/questions.ts": "d2981be8ecd70f69b140f783c2db8fe9af46b7805e3d55fe2dd8d74ac4abc040",
  "src/migrations/release.ts": "c86fcd1bdafb2ab0c96131a84774e7ffef10f3fe6b4d2eddafa5ad981411cc5a",
  "src/migrations/runner.ts": "a70df32c8c616a0662e465b7ed381b4c309ce7409f4a8eb0ca77d73cf6ddb76b",
  "src/migrations/types.ts": "32794b6a450416bfa508ac085a3eb9afc8f393e37d1dacbf59767703090e13cc",
  "src/migrations/validators.ts": "611ea7c0caef4dae3a98d9c67fe9f4f488567d99bb78c48693af75b538b58354",
  "src/migrations/worker.ts": "abbb9442390c4d4184a134c43e4967551273c2a27f2b228e6f812c986de6ce65",
  "src/migrations/workspace-v11.ts": "de649ed8a46d20f529f96e00d017c1c448f79c3dd5b48495329b5f53433f7250",
  "src/persistence/files.ts": "c17a26cceaa7a2aabcda95c20b5fad5eb082213f6afe3bc7aacf513c87b537f3",
  "src/persistence/schema.ts": "339cb24ea06db79c6557d735cd74ba486a9ae9b587b5273b162919c2ad6bda7a",
  "src/persistence/script-journal.ts": "d916b54c1997d55532b0384641e81f9059d078d7ccc6ead8168a58fba30954a7",
  "src/persistence/script-maintenance.ts": "9b57195afa356ffc6963c1398295c4512e59e5fa350e289afc8a74be532a00d6",
  "src/persistence/store.ts": "a5c648e28fe3bc2eaed3f14932229df86ba5d518ab02df6cab1b2ce9213eb5a7",
  "src/project-git/files.ts": "537f8915ae1a3be9c94448d65405fc7a47735ea76affe6d30d0d7a17e944d3bb",
  "src/project-git/git.ts": "13d2645792db44cbe04ed90ab344e16d0e4f954591b8a32a2b3d28161d098719",
  "src/project-git/materialize.ts": "cb0477973c5c06245abe58de71a7e2dd81658e66ef1613bfe574b11bd4e5a588",
  "src/project-git/routes.ts": "f09ad57312b9f21390a5eedb37bbdf897f5a47aa7cc5d4e0bac1a04a9bff3bf1",
  "src/project-git/service.ts": "1a0fd0bc70b9dd93baefbd7a1568dc715037a1353a01ab6034e6a68109d96ccd",
  "src/project-git/ssh.ts": "d7ca92798cf5028e3c8f2043ca5174fbf22b26a99f686d8f57da3513caee821a",
  "src/project-git/types.ts": "e749d318c86734db817ac7623d8b4911ed421dd6fbf8174d15bca9115c7994c6",
  "src/providers/agent-limits.ts": "c3a26de962c275a34b902d61c0ee999158833624a337bcdf8686b5d61fe4ed35",
  "src/providers/codex-app-server.ts": "a244fa661da4408d12cd39bffb76f23a012ab5e9c327c929b66a1e5f8b4df270",
  "src/providers/codex-config.ts": "0172aee1c55490b99dcb1c9754fd37f0c903687e796ea1d0626af954337dd9e6",
  "src/providers/codex-session-lifecycle.ts": "91908f7a0a58ead535b6d52423e36d9c3ec8c76a5d49161d0c8800f56c8ebf4f",
  "src/providers/event-batcher.ts": "1fea4a2e47ba81903469e58a5d01f4427c1cf271f8eaeed7dce4bd75c3892229",
  "src/providers/managed-session-store.ts": "9a80ea7e2a3e9845bc29a3b5e69b65ae1258b0ca0d8f8cdeea3a8c393c9f2160",
  "src/providers/pi-rpc.ts": "e4f3c00ee4ed978d77312a4ad36e28e261608355bf033dcea89e1186f379df34",
  "src/providers/pi-session-lifecycle.ts": "ba7db83c87f52c5804bf474ae65ce064457d7666092feebcf91e1500c041c029",
  "src/providers/registry.ts": "4269915d77380f8fc49826243c2da4a87bba9948f556ce21665add9229ce4640",
  "src/providers/session-manager.ts": "5a756ac856fd62e6c839ec339f1281fbb32aac5c25792b9a5bef8ec6f6fd6c27",
  "src/providers/session.ts": "a7b6c51c109490ff147df659fe368f1aa1896edcb4c55367d7f57faabbf52521",
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
  "src/server/app.ts": "296dcb17e3677f5acf1f6fb31cbdaf2febb86ffed8b4eb7ca3d24a3aa71908c7",
  "src/server/bootstrap.ts": "294750eae786d119e6a9e3331939bd3f37ef7c2bbad25757c2a6e89ef7342136",
  "src/server/main.ts": "ab2b1864c74accd8fc834e3971c9e57382bfb80b22de63a3a68a21061f7b149f",
  "src/server/notifications.ts": "d2cccda01fcf8b99c404c4c5bb83020029aa6829bcbfb7edf53652857cff7fb2",
  "src/storage/usage.ts": "776e78c5aa3a6e7a398de1765e1143df7dc5dc609d0ff97602df06d96fca8a3b",
  "src/web-bridge/agent.ts": "b778fb7910a35ced0271a89489b76db684a74549948191c5b26c76fcb74519f3",
  "src/web-bridge/auth.ts": "489a36654e1aa0e88e8905b51082392107845b99b9a2deb6cb80c68789d2323b",
  "src/web-bridge/authoring.ts": "a700c51c6fe3c207967985acf2b6187df1c2d5dbb4973e00446c439ad87e9dc9",
  "src/web-bridge/browser-execution.ts": "b5db73d590757ca51221768b091c3c25c89de61e967c3a25160a6e643ff7e331",
  "src/web-bridge/catalog.json": "37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570",
  "src/web-bridge/catalog.ts": "c8b5243eece81df1460c1da638c9388de1197886426ebaefb8cc861b763e3a79",
  "src/web-bridge/client.ts": "8650628ecfda5f27a7b5cd7d1d3bc5f4149cd4d2ef373814ce9d7b5e0e31d974",
  "src/web-bridge/config-validation.ts": "31f6a10cfe97ad62a7d3357b1436a1838d616bc83d34d21bce68951292c5eeb3",
  "src/web-bridge/config.ts": "ad9a5b70353a7bc62e9858aea5672b64bc80a85731e3f5d910d04091867afb6a",
  "src/web-bridge/configured.ts": "a069f9af4cb18385e7436fe03f09c7e7c716276da5e3ddc719a4c975e2ea7d30",
  "src/web-bridge/credential-inputs.ts": "26976dc75e00328c9d14d82c4a950db0d376c01be6fe82225da53ad870775551",
  "src/web-bridge/credential-schema.ts": "146008b27224e2f5e7c53177ee0cfd38b7a4a9b6e00507acc98c04a6bcd33e1f",
  "src/web-bridge/credentials.ts": "1593af732403058076c1ad0c43e0ec8a5f0455f7a61fdc5a11a584028c468f10",
  "src/web-bridge/database-config.ts": "6f4b7f113a2c44e379a8b3920ba5808e1ad5de75c70b5740f17ee9a3e1042d5f",
  "src/web-bridge/execution.ts": "2abf4b936109ab699a4734feec245d32f50316dc0c534b183098b090f152de3f",
  "src/web-bridge/extension/background.js": "3fbd40e6ac79524caf3977f2470ab0d9e79c3c338591e58d08c08c0c846824e3",
  "src/web-bridge/extension/manifest.json": "8e383e542fcec7c8a0b6fbe97ec6e404c56b4b4d319c8ec128b31a41eabfacd8",
  "src/web-bridge/extension/popup.css": "d0966e7078aef693cbbc9d7f400b533b4ec3fecd76d9bb24812c10d0a1f08461",
  "src/web-bridge/extension/popup.html": "afe35139a74603e81e0fd5cee99440c2cff89c5296d7c7fd21a3b17ab7223df9",
  "src/web-bridge/extension/popup.js": "41061c4c3319a35db50dc66e4808234440dba58950f3457359fe9fee91ec74fc",
  "src/web-bridge/gateway.ts": "c3877e4f3f67f1a6faa116fa283b9e8541183c8c84cdcfcb7af2986e7c634108",
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
  "src/web/agent-chat/MaintenanceOwnerPanel.tsx": "561d1db42c1011d6a2d19b91e9762e2ef32b4e61834d40c7dd3ebbc337c4380d",
  "src/web/agent-chat/MaintenanceProposalReview.tsx": "1f96406deb5e7ee9a92d90a2623127ddde5ddb7fd30d51aff602a797b48e3c8d",
  "src/web/agent-chat/adapters/browser-application.tsx": "a0ec11ae508b8d48f067f9b2794a9563d4502cf69c9f66eec37050a981345d03",
  "src/web/agent-chat/adapters/script.tsx": "cbb0686bd42a58d2ffa3a3dfb0c7419a851c1736ae8870866a8376013e7e9e75",
  "src/web/agent-chat/adapters/workflow.tsx": "f5dbb71c07917bf2b31a647e429d86e4a4c454d670eeaf8200fa52e038ebe7a3",
  "src/web/agent-chat/agent-chat.css": "011aa8bb24f4b1581377a15f4425d13cda65bbeb77f14a58c31b71a6fb15c1b2",
  "src/web/agent-chat/types.ts": "4fd2cc51ad10e0b7ec84bc5ef4d68543c72d2ada7262ce2f0ab6206ba890bf8d",
  "src/web/agent-chat/useAgentChat.ts": "c8c46cc7b45ee16ad2f97fdac1be5520cb91ebd944a6464f1639ae3bc271f074",
  "src/web/agent-chat/useChatPolling.ts": "a79630407e85ccc761271c4c4fd7871c44a717aa4e67228666097869f8f505cb",
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
  "src/web/features/AgentKnowledgeSettings.tsx": "8bdfc178d35fee0d5d42d3d23f318bccec19b494295c2297a363791270c0690d",
  "src/web/features/AgentModelConfigPicker.tsx": "179fba5e7f50dd954b2e02c8f6dd66a3f17b20db5e0350b75465bb4b2313d4e6",
  "src/web/features/AgentModelConfigSettings.tsx": "f4ce83c71fbe27e1420bdeb06814ec41632330b7d3c3582be451b35321b04cd0",
  "src/web/features/AgentPromptPreview.tsx": "be84b68d7c02437f421278670f61dcf1ed965120304ca74b2db120011a3ce663",
  "src/web/features/ArchiveConversationButton.tsx": "a8b0b293239a779f183d1e45273c0b5aaf445076c10c2495945a088d8d482d63",
  "src/web/features/BridgeAgentPanel.tsx": "f2a78a6ad272911a5d57fbae4f1b3337b5c59e27ecfd7cf2ba12cc35e40b4b7c",
  "src/web/features/BridgeCredentialInputs.tsx": "279eb748fb4df3689747e43fe0797e72593e788fb8cde9d5f5b480d01bf1ce5e",
  "src/web/features/BridgeExecutionHistory.tsx": "754bedb21695207f755c706c34f121f49c57c7a688635d89b98b4c3fc1e33c31",
  "src/web/features/BridgeNodeCredentials.tsx": "ba32c1ebe9597501cf3b507566a05ab4e684c77412bd10ee364f76631c93ec5f",
  "src/web/features/BridgeParameterInputs.tsx": "224a17f051a5beebcc47c3816de6232996d8e8343a2b10c759b3a568c0057e02",
  "src/web/features/BridgeToolForm.tsx": "937da89144297349d07f6b506add94246b4b237dd7b1e0d9963f0286dcc7dead",
  "src/web/features/CodeEditor.tsx": "b0c3d7540dff188ca183a32e0a6c004b65bb1b10cfcc078ec8cf7ece7dbefc8b",
  "src/web/features/ConfigGitMessageAgentSettings.tsx": "ef55f509bf064b50375aa859d1cedc78ef7046ebc703540394fb0d45d45da648",
  "src/web/features/ConfigGitSettings.tsx": "9c9fabbc41e8e07abc185778ca93f5f74ddd040795057603fc02a1857a951213",
  "src/web/features/ConversationDrawer.tsx": "f5f777bd31e45f39ff0b4f405386793197bfcbda0d4e72d87cb66c6b59a0fe2a",
  "src/web/features/DeleteDictionaryButton.tsx": "65526abe69df3b1b720d5b483e30f091aaaff70f382a801ebae896ab1cfe8849",
  "src/web/features/DeleteScriptButton.tsx": "37b91e388366f3b05ebf572dae7db42c4c334507967a6546c43c42ee9931a503",
  "src/web/features/DeleteWorkflowButton.tsx": "c98b76855e29881c92dae1ee5560ed66accc55978265c455516e69be388efeff",
  "src/web/features/DictionariesPage.tsx": "f88066a8982fce0d5cc5b37dafc60adc4244ca6fbbb29a3fcee2c784666a9c89",
  "src/web/features/DictionaryEditors.tsx": "4d750465ff522254f9f8ff3495ea84cbbdcb53d8d6349fc4dc57fd7317598552",
  "src/web/features/DraftPage.tsx": "3db4e09b4d52907746d733cfe2ad7b00f3cd05acbe92f13bb39a3248ac95fdb0",
  "src/web/features/FinalResult.tsx": "178ae2f3d12d481e0d33eb1e7db253786c2ebd554b8fc4a993570b73fe389d32",
  "src/web/features/FlowCanvas.tsx": "e359cbad66510fc8f6d8d4d8e14d13adadb288e44fe80a806318a2cd77f23e8c",
  "src/web/features/GitProjectSettings.tsx": "66c330e78661cb76a0d698c20b3c1d660d8d9073bfab14d236a2c8b251b7fd15",
  "src/web/features/ModelManager.tsx": "f03693b472805a167f159fa90bc9a8285533cce1000c2189da0d2a429f4ed1b1",
  "src/web/features/ProjectContextPicker.tsx": "09a511c2900978e3edaea8ee0020efa3ba0cb331d1150eaf193033536d5bacc6",
  "src/web/features/ProviderPicker.tsx": "97ce1eaf3364e9a553ef4934e864d88b237ca61ed5054f49304e62df9657cab1",
  "src/web/features/RemoteConfigSync.tsx": "bedfbe23d388013cd057ea37e208886ba01d4fc6e7e9d9aba576c170b53b18cb",
  "src/web/features/RunPages.tsx": "33614b41eb21894b1399cb8b042bc651e44e2997d0b35624d3b3bd2a7bc2aac7",
  "src/web/features/SchemaEditor.tsx": "9f01352f1392f3831a83d1421b72d868c654f8511279b09fd4bfefedffae54fa",
  "src/web/features/ScriptAgentPanel.tsx": "54e6523f7fa27a90b5f65bf1ed2f771eff42f178944db81291cf8ab9a1b2cd36",
  "src/web/features/ScriptAgentPreview.tsx": "1f6b56640b63601444865eab7eadf9c3bdc60caaafd9d2901933cb40cff66d3f",
  "src/web/features/ScriptNodePicker.tsx": "e908aa883c4435cdb66f9287c9d54f1122a78e9a0ab5ead4c06324714a4b2117",
  "src/web/features/ScriptPages.tsx": "0d9cc728903930a4a7136b8e6b8bfc726417e2ba81af63d45cc45b86809ce43b",
  "src/web/features/ScriptRunInspector.tsx": "f5625915796e09c177053369f0aaa9a54060c952e5505a5b4e2ec43477208dd3",
  "src/web/features/ScriptTestParameters.tsx": "15adf2f14d7f403f7489c265913522c73a6533b618965febfc8657e6526f223a",
  "src/web/features/ScriptVersionPanels.tsx": "6ea1c719aa8e5b79ec8fdc33e70981cdef7f43a99a3f8c933208e05477d3c07f",
  "src/web/features/SecretKeySettings.tsx": "5fb8d76c4ed51a6987c86784fc5fecbbb68e92923648dd560f5c84f9a294ccab",
  "src/web/features/SettingsPage.tsx": "2c75bae6e974d3115ab8bc907af5e39864ef6b490bb256e53f7f3c2fe7826730",
  "src/web/features/SourceTabs.tsx": "e777d5d1045395bf34860a78ef6f455d36f557ea0de01762ac64db7bec7bec48",
  "src/web/features/StorageSettings.tsx": "06604737f88ce2910e66d7c2003ba48dddbba7f4ac96f84cb8857ec043a0bade",
  "src/web/features/WebBridgeSettings.tsx": "3f62127ab827dd256292cdb88447e41e9bb133bfa95b5e81cedeebe855c2de38",
  "src/web/features/WorkflowOutputEditor.tsx": "b287b056c8cee2cdfdea1acc8a71d73b8f1d74307d86970398c5fd79b73c69f5",
  "src/web/features/WorkflowPages.tsx": "4b42cc94ff3febb9a1111e0247a1513de5e577067ab7ae6e06198be96b595cf0",
  "src/web/features/agent-knowledge-settings.css": "5237b8cf6ade560c0448de9bf53acdd1d49ce6bdcfb21f225257ea3554fa9442",
  "src/web/features/agent-prompt-preview.css": "4201bb49067575c767ca5304769e4da3ca96fba21377003587c85e501c980f43",
  "src/web/features/dictionaries.css": "c00e1c5604222617dae277be94c274ba0f2ded55c928c0d4b4420601a7125f4f",
  "src/web/features/graph.ts": "071d4031e27e20615a79e80297fd0e6104a61c8e0b3027e3f91f6b8b9281b91f",
  "src/web/features/secret-key-settings.css": "a5b810f2b77293b3a4cea4eff27eaaef44e31ffd628242c09cd2760a21d22db6",
  "src/web/lib/api.ts": "f9a54a438d2ced9bc48154b68cf49e2f8c9e191edee98a8a69b2f46bf361ea46",
  "src/web/lib/editor-theme.ts": "ea2f3577454be160560259b32b362a91a88085ba99e33f8838098b42c5710acc",
  "src/web/lib/notifications.tsx": "13d321ceed8779aeba0d54ec444b887b6429edac3ae9cd24c229a4654272b11c",
  "src/web/lib/schema-editor.ts": "3cd38967ea2071eb3081cb17104991b1eeb8f0f28a25c526d409c631de887f10",
  "src/web/lib/theme.tsx": "a91ba0a903ebdd3f20fcd6a98074fa7dd10b7d2d54624192fbabe135232c08d5",
  "src/web/lib/utils.ts": "64fc84c1be627f0d586fb4ba64d824a1604f44282381f5bae68cdf86e10bb6ec",
  "src/web/main.tsx": "fe7cb51cf0dcf86e7854817e4c9cbba16b1548b620df8487dad4811c4a7d4160",
  "src/web/styles.css": "051a85f0e790b2d91c3331049ea9fd2f81b1695b3aa48716236c8e17a2a01fd6",
  "tests/fixtures/migrations/config/v0-empty.json": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
  "tests/fixtures/migrations/config/v0-full.json": "c8ad3a6baf7f06bb1b403a9fefd738cbf3e9b3f74168c52762ed61abbcfadd0c",
  "tests/fixtures/migrations/config/v0-partial.json": "20401c22a2303b77d0d99d15acd00a6f824659295db2556df5bbc16351d90f38",
  "tests/fixtures/migrations/config/v1-full.json": "008abcd9e07602a8be426ace85532f1e0fb280a7817825a9acdf53c1f370f9c6",
  "tests/fixtures/migrations/database/provenance.json": "5cd4d9e38c9f45026d11c96da710961b157c22f5d3f8a7434cc4fac53fa8f1ec",
  "tests/fixtures/migrations/database/v1.sql": "3fb10171ffa8f3331bd944e141f20cda01088f944debee353cedc5e49e4dab09",
  "tests/fixtures/migrations/database/v10.sql": "3a54c945412ca01ee09804acee984b1b00f71af2da99783b70bab2470f6f4a91",
  "tests/fixtures/migrations/database/v11.sql": "0da1a5c0ce232c889f22cfb3fb09cdf37397f9d92d51ce61af6660dd320ba82e",
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
  "tsconfig.server.json": "0a2e5bc8dfcc1f5b5b1febb166d39cd2a4eccc6ee71575125cf7aa9af8396690",
  "vite.config.ts": "8fd36b5909b6236e56c3b141421280411150532c04e3969e9647fcb65f4541d7"
};
