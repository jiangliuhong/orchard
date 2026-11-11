/** Approved in docs/features/2026-11-11-unified-agent-runtime/schema-review.md.
 * This module does not initialize or migrate a production database on import.
 * Activation requires the versioned migration/reset and completed runtime cutover.
 */
const integer = (name: string, minimum: number) => `typeof(${name})='integer' AND ${name}>=${minimum}`;
const hash = (name: string) => `length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*'`;
const object = (name: string) => `CASE WHEN json_valid(${name}) THEN json_type(${name})='object' ELSE 0 END`;
const optionalObject = (name: string) => `${name} IS NULL OR (${object(name)})`;
const reference = (name: string) => `${object(name)} AND length(CAST(${name} AS BLOB))<=65536`;
const active = "'queued','running','cancel_requested'";

export const AGENT_RUNTIME_SCHEMA = `
CREATE TABLE agent_workspaces (
 id TEXT NOT NULL PRIMARY KEY,
 relative_path TEXT NOT NULL UNIQUE CHECK(relative_path='agent/workspace'),
 knowledge_hash TEXT NOT NULL CHECK(${hash("knowledge_hash")}),
 installation_state TEXT NOT NULL CHECK(installation_state IN ('initializing','ready','failed')),
 revision INTEGER NOT NULL CHECK(${integer("revision", 1)}),
 updated_at INTEGER NOT NULL
);
CREATE TABLE agent_conversations (
 id TEXT NOT NULL PRIMARY KEY,
 actor_key TEXT NOT NULL CHECK(length(trim(actor_key))>0),
 scenario TEXT NOT NULL CHECK(length(scenario) BETWEEN 1 AND 100),
 owner_type TEXT NOT NULL CHECK(length(owner_type) BETWEEN 1 AND 100),
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 200),
 owner_scope_json TEXT NOT NULL CHECK(${object("owner_scope_json")}),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 current_model_id TEXT NOT NULL CHECK(length(trim(current_model_id))>0),
 knowledge_hash TEXT CHECK(knowledge_hash IS NULL OR (${hash("knowledge_hash")})),
 contract_version TEXT NOT NULL CHECK(length(trim(contract_version))>0),
 tool_policy_version TEXT NOT NULL CHECK(length(trim(tool_policy_version))>0),
 workspace_id TEXT REFERENCES agent_workspaces(id),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleting')),
 usability TEXT NOT NULL CHECK(usability IN ('usable','knowledge_outdated','backend_unavailable','owner_unavailable')),
 revision INTEGER NOT NULL CHECK(${integer("revision", 1)}),
 title TEXT CHECK(title IS NULL OR length(title) BETWEEN 1 AND 200),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(id,mode), UNIQUE(id,provider_id),
 CHECK(mode!='multi' OR (knowledge_hash IS NOT NULL AND workspace_id IS NOT NULL))
);
CREATE TABLE agent_turns (
 id TEXT NOT NULL PRIMARY KEY,
 conversation_id TEXT NOT NULL, mode TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(${integer("sequence", 1)}),
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
 request_hash TEXT NOT NULL CHECK(${hash("request_hash")}),
 status TEXT NOT NULL CHECK(status IN (${active},'succeeded','failed','cancelled','interrupted')),
 submission_state TEXT NOT NULL CHECK(submission_state IN ('not_sent','sending','accepted','settled')),
 requested_model_id TEXT NOT NULL CHECK(length(trim(requested_model_id))>0),
 actual_model_id TEXT,
 model_source TEXT CHECK(model_source IS NULL OR model_source IN ('requested','reported','unknown')),
 generation INTEGER NOT NULL CHECK(${integer("generation", 0)}),
 input_ref TEXT, proposal_ref TEXT,
 error_json TEXT CHECK(${optionalObject("error_json")}),
 base_revision TEXT,
 read_baselines_json TEXT NOT NULL DEFAULT '{}' CHECK(${object("read_baselines_json")}),
 apply_status TEXT NOT NULL CHECK(apply_status IN ('not_applicable','pending','applied','rejected','failed')),
 outcome_ref TEXT,
 created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 FOREIGN KEY(conversation_id,mode) REFERENCES agent_conversations(id,mode) ON DELETE CASCADE,
 UNIQUE(conversation_id,sequence), UNIQUE(conversation_id,request_id), UNIQUE(id,conversation_id),
 CHECK(mode!='single' OR sequence=1)
);
CREATE TABLE agent_backends (
 conversation_id TEXT NOT NULL PRIMARY KEY,
 provider_id TEXT NOT NULL,
 ref_version INTEGER NOT NULL CHECK(${integer("ref_version", 1)}),
 reference_json TEXT NOT NULL CHECK(${reference("reference_json")}),
 fingerprint TEXT NOT NULL CHECK(${hash("fingerprint")}),
 generation INTEGER NOT NULL CHECK(${integer("generation", 1)}),
 health TEXT NOT NULL CHECK(health IN ('available','unknown','unavailable')),
 native_delete_state TEXT NOT NULL CHECK(native_delete_state IN ('present','pending','unknown','absent')),
 updated_at INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,provider_id) REFERENCES agent_conversations(id,provider_id) ON DELETE CASCADE
);
CREATE TABLE agent_operations (
 id TEXT NOT NULL PRIMARY KEY,
 conversation_id TEXT REFERENCES agent_conversations(id),
 subject_id TEXT NOT NULL CHECK(length(subject_id)>0),
 actor_key TEXT NOT NULL CHECK(length(trim(actor_key))>0),
 kind TEXT NOT NULL CHECK(kind IN ('turn','delete','switch_model','knowledge_install')),
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
 request_hash TEXT NOT NULL CHECK(${hash("request_hash")}),
 expected_revision INTEGER CHECK(expected_revision IS NULL OR (${integer("expected_revision", 1)})),
 expected_generation INTEGER CHECK(expected_generation IS NULL OR (${integer("expected_generation", 0)})),
 status TEXT NOT NULL CHECK(status IN ('pending','running','unknown','failed','succeeded')),
 phase TEXT NOT NULL CHECK(phase IN ('prepared','closing','provider_pending','provider_confirmed','platform_pending','done')),
 target_reference_json TEXT CHECK(target_reference_json IS NULL OR (${reference("target_reference_json")})),
 result_json TEXT CHECK(${optionalObject("result_json")}),
 error_json TEXT CHECK(${optionalObject("error_json")}),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER,
 UNIQUE(actor_key,subject_id,kind,request_id),
 CHECK(status!='succeeded' OR (phase='done' AND settled_at IS NOT NULL)),
 CHECK(kind!='delete' OR status!='succeeded' OR (conversation_id IS NULL AND target_reference_json IS NULL))
);
CREATE TABLE agent_events (
 conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(${integer("sequence", 1)}),
 event_id TEXT NOT NULL UNIQUE,
 turn_id TEXT,
 operation_id TEXT REFERENCES agent_operations(id),
 generation INTEGER NOT NULL CHECK(${integer("generation", 0)}),
 type TEXT NOT NULL CHECK(length(type)>0),
 role TEXT CHECK(role IS NULL OR role IN ('user','assistant','host','system')),
 payload_ref TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,sequence),
 FOREIGN KEY(turn_id,conversation_id) REFERENCES agent_turns(id,conversation_id) ON DELETE CASCADE
);
CREATE TABLE agent_host_feedback (
 event_id TEXT NOT NULL PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 turn_id TEXT,
 operation_id TEXT REFERENCES agent_operations(id),
 generation INTEGER NOT NULL CHECK(${integer("generation", 0)}),
 type TEXT NOT NULL CHECK(type IN ('applied','rejected','resource_changed','selected_test_changed')),
 payload_json TEXT NOT NULL CHECK(${object("payload_json")}),
 status TEXT NOT NULL CHECK(status IN ('pending','delivered','unknown')),
 receipt_json TEXT CHECK(${optionalObject("receipt_json")}),
 created_at INTEGER NOT NULL, delivered_at INTEGER,
 FOREIGN KEY(turn_id,conversation_id) REFERENCES agent_turns(id,conversation_id),
 CHECK(status!='delivered' OR (receipt_json IS NOT NULL AND delivered_at IS NOT NULL))
);
CREATE TABLE agent_runtime_resources (
 operation_id TEXT NOT NULL PRIMARY KEY REFERENCES agent_operations(id),
 relative_path TEXT NOT NULL UNIQUE CHECK(relative_path='agent/runtime/'||operation_id),
 purpose TEXT NOT NULL CHECK(purpose IN ('single','project','provider_private')),
 lease_instance TEXT NOT NULL CHECK(length(lease_instance)>0),
 generation INTEGER NOT NULL CHECK(${integer("generation", 1)}),
 process_state TEXT NOT NULL CHECK(process_state IN ('absent','starting','running','stopped','unknown')),
 release_state TEXT NOT NULL CHECK(release_state IN ('retained','pending','released','failed')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK(length(operation_id) BETWEEN 1 AND 100 AND operation_id NOT GLOB '*[^a-zA-Z0-9_-]*')
);
CREATE TABLE agent_knowledge_installation (
 id TEXT NOT NULL PRIMARY KEY CHECK(id='current'),
 bundle_version TEXT NOT NULL,
 knowledge_hash TEXT NOT NULL CHECK(${hash("knowledge_hash")}),
 manifest_json TEXT NOT NULL CHECK(${object("manifest_json")}),
 state TEXT NOT NULL CHECK(state IN ('initializing','ready','failed')),
 error_json TEXT CHECK(${optionalObject("error_json")}),
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX agent_one_active_turn ON agent_turns(conversation_id) WHERE status IN (${active});
CREATE UNIQUE INDEX agent_single_turn ON agent_turns(conversation_id) WHERE mode='single';
CREATE UNIQUE INDEX agent_one_control_operation ON agent_operations(conversation_id)
 WHERE kind IN ('delete','switch_model') AND settled_at IS NULL;
CREATE INDEX agent_conversations_by_owner ON agent_conversations(actor_key,scenario,owner_type,owner_id,updated_at DESC,id);
CREATE INDEX agent_conversations_by_lifecycle ON agent_conversations(lifecycle,updated_at DESC,id);
CREATE INDEX agent_turns_by_conversation ON agent_turns(conversation_id,sequence);
CREATE INDEX agent_operations_pending ON agent_operations(status,updated_at,id) WHERE settled_at IS NULL;
CREATE INDEX agent_feedback_pending ON agent_host_feedback(conversation_id,created_at,event_id) WHERE status IN ('pending','unknown');
CREATE INDEX agent_runtime_release ON agent_runtime_resources(release_state,updated_at,operation_id);

CREATE TRIGGER agent_conversation_identity_immutable
BEFORE UPDATE OF id,actor_key,scenario,owner_type,owner_id,owner_scope_json,mode,provider_id,knowledge_hash,contract_version,tool_policy_version,workspace_id ON agent_conversations
WHEN ${["id", "actor_key", "scenario", "owner_type", "owner_id", "owner_scope_json", "mode", "provider_id", "knowledge_hash", "contract_version", "tool_policy_version", "workspace_id"].map(key => `NEW.${key} IS NOT OLD.${key}`).join(" OR ")}
BEGIN SELECT RAISE(ABORT,'AGENT_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER agent_conversation_deleting BEFORE UPDATE OF lifecycle ON agent_conversations
WHEN NEW.lifecycle!=OLD.lifecycle AND (NEW.lifecycle='active' OR EXISTS(SELECT 1 FROM agent_turns WHERE conversation_id=OLD.id AND status IN (${active})))
BEGIN SELECT RAISE(ABORT,'AGENT_LIFECYCLE_CONFLICT'); END;
CREATE TRIGGER agent_conversation_delete_guard BEFORE DELETE ON agent_conversations
WHEN OLD.lifecycle!='deleting'
 OR EXISTS(SELECT 1 FROM agent_turns WHERE conversation_id=OLD.id AND status IN (${active}))
 OR EXISTS(SELECT 1 FROM agent_backends WHERE conversation_id=OLD.id AND native_delete_state!='absent')
BEGIN SELECT RAISE(ABORT,'AGENT_DELETE_UNCONFIRMED'); END;
CREATE TRIGGER agent_turn_identity_immutable
BEFORE UPDATE OF id,conversation_id,mode,sequence,request_id,request_hash ON agent_turns
WHEN ${["id", "conversation_id", "mode", "sequence", "request_id", "request_hash"].map(key => `NEW.${key} IS NOT OLD.${key}`).join(" OR ")}
BEGIN SELECT RAISE(ABORT,'AGENT_TURN_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER agent_single_turn_retained BEFORE DELETE ON agent_turns
WHEN OLD.mode='single' AND EXISTS(SELECT 1 FROM agent_conversations WHERE id=OLD.conversation_id AND lifecycle!='deleting')
BEGIN SELECT RAISE(ABORT,'AGENT_SINGLE_TURN_RETAINED'); END;
${["INSERT", "UPDATE OF status,conversation_id"].map((event, i) => `
CREATE TRIGGER agent_turn_admission_${i} BEFORE ${event} ON agent_turns
WHEN NEW.status IN (${active}) AND (
 NOT EXISTS(SELECT 1 FROM agent_conversations WHERE id=NEW.conversation_id AND lifecycle='active' AND usability='usable')
 OR EXISTS(SELECT 1 FROM agent_operations WHERE conversation_id=NEW.conversation_id AND kind IN ('delete','switch_model') AND settled_at IS NULL))
BEGIN SELECT RAISE(ABORT,'AGENT_TURN_BLOCKED'); END;`).join("\n")}
${["INSERT", "UPDATE OF status,settled_at,kind,conversation_id"].map((event, i) => `
CREATE TRIGGER agent_operation_admission_${i} BEFORE ${event} ON agent_operations
WHEN NEW.kind IN ('delete','switch_model') AND NEW.settled_at IS NULL AND (
 NOT EXISTS(SELECT 1 FROM agent_conversations WHERE id=NEW.conversation_id)
 OR EXISTS(SELECT 1 FROM agent_turns WHERE conversation_id=NEW.conversation_id AND status IN (${active}))
 OR (NEW.kind='switch_model' AND NOT EXISTS(SELECT 1 FROM agent_conversations WHERE id=NEW.conversation_id AND lifecycle='active' AND usability='usable')))
BEGIN SELECT RAISE(ABORT,'AGENT_OPERATION_BLOCKED'); END;`).join("\n")}
CREATE TRIGGER agent_operation_identity_immutable
BEFORE UPDATE OF id,subject_id,actor_key,kind,request_id,request_hash ON agent_operations
WHEN ${["id", "subject_id", "actor_key", "kind", "request_id", "request_hash"].map(key => `NEW.${key} IS NOT OLD.${key}`).join(" OR ")}
BEGIN SELECT RAISE(ABORT,'AGENT_OPERATION_IDENTITY_IMMUTABLE'); END;
${["INSERT", "UPDATE"].map((event, i) => `
CREATE TRIGGER agent_backend_validation_${i} BEFORE ${event} ON agent_backends
WHEN NOT EXISTS(SELECT 1 FROM agent_conversations WHERE id=NEW.conversation_id AND mode='multi' AND provider_id=NEW.provider_id)
 OR CASE WHEN json_valid(NEW.reference_json) THEN
    json_type(NEW.reference_json) IS NOT 'object'
    OR json_extract(NEW.reference_json,'$.providerId') IS NOT NEW.provider_id
    OR json_type(NEW.reference_json,'$.version') IS NOT 'integer'
    OR json_extract(NEW.reference_json,'$.version') IS NOT NEW.ref_version
    OR json_type(NEW.reference_json,'$.opaque') IS NULL
    OR (SELECT count(*) FROM json_each(NEW.reference_json))!=3
    ELSE 1 END
BEGIN SELECT RAISE(ABORT,'AGENT_BACKEND_INVALID'); END;`).join("\n")}
CREATE TRIGGER agent_backend_generation BEFORE UPDATE ON agent_backends
WHEN NEW.generation<OLD.generation OR NEW.conversation_id!=OLD.conversation_id OR NEW.provider_id!=OLD.provider_id
BEGIN SELECT RAISE(ABORT,'AGENT_BACKEND_GENERATION_CONFLICT'); END;
`;
