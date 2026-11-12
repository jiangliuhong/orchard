/** Reviewed eight-table schema; see database-approval.json in the workspace feature.
 * Declarative SQL only: importing this module never opens a DB, changes user_version,
 * activates the legacy nine-table reset or installs a production migration.
 */
const integer = (name: string, min = 0) => `typeof(${name})='integer' AND ${name} BETWEEN ${min} AND 9007199254740991`;
const text = (name: string, max = 200) => `typeof(${name})='text' AND length(trim(${name})) BETWEEN 1 AND ${max}`;
const hash = (name: string) => `length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*'`;
const object = (name: string, bytes = 65536) => `CASE WHEN json_valid(${name}) THEN json_type(${name})='object' AND length(CAST(${name} AS BLOB))<=${bytes} ELSE 0 END`;
const nullable = (name: string, predicate: string) => `${name} IS NULL OR (${predicate})`;
const safeId = (name: string) => `${text(name)} AND ${name} GLOB '[a-zA-Z0-9_-]*' AND ${name} NOT GLOB '*[^a-zA-Z0-9_.-]*'`;
const active = "'queued','running','stopping'";
// INSERT OR REPLACE can delete a conflicting row without running UPDATE guards.
// Reject existing unique identities before SQLite's conflict handler can do that.
const noReplace = (table: string, condition = "id=NEW.id") => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${condition})
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_ROW_EXISTS'); END;
`;
const immutable = (table: string, suffix: string, columns: string[], condition?: string) => `
CREATE TRIGGER ${table}_${suffix} BEFORE UPDATE ON ${table}
WHEN ${condition ?? columns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_${suffix.toUpperCase()}'); END;
`;

export const WORKSPACE_MAINTENANCE_SCHEMA = `
CREATE TABLE bridge_configuration (
 id TEXT NOT NULL PRIMARY KEY CHECK(id='current'),
 revision INTEGER NOT NULL CHECK(${integer("revision", 1)}),
 config_json TEXT NOT NULL CHECK(${object("config_json", 16 * 1024 * 1024)}),
 content_hash TEXT NOT NULL CHECK(${hash("content_hash")}),
 updated_at INTEGER NOT NULL CHECK(${integer("updated_at")})
);
CREATE TABLE agent_workspace_workflow_bindings (
 draft_id TEXT NOT NULL PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
 resource_id TEXT NOT NULL CHECK(${safeId("resource_id")}),
 created_at INTEGER NOT NULL CHECK(${integer("created_at")})
);
CREATE TABLE agent_workspace_projection_state (
 id TEXT NOT NULL PRIMARY KEY CHECK(id='maintenance'),
 target_generation INTEGER NOT NULL CHECK(${integer("target_generation", 1)}),
 synced_generation INTEGER NOT NULL CHECK(${integer("synced_generation")} AND synced_generation<=target_generation),
 target_knowledge_hash TEXT NOT NULL CHECK(${hash("target_knowledge_hash")}),
 synced_knowledge_hash TEXT CHECK(${nullable("synced_knowledge_hash", hash("synced_knowledge_hash"))}),
 content_hash TEXT CHECK(${nullable("content_hash", hash("content_hash"))}),
 state TEXT NOT NULL CHECK(state IN ('pending','syncing','ready','failed')),
 error_code TEXT CHECK(${nullable("error_code", text("error_code"))}),
 updated_at INTEGER NOT NULL CHECK(${integer("updated_at")}),
 CHECK(state!='ready' OR (target_generation=synced_generation AND synced_knowledge_hash IS NOT NULL AND synced_knowledge_hash=target_knowledge_hash AND content_hash IS NOT NULL))
);
CREATE TABLE agent_maintenance_sessions (
 id TEXT NOT NULL PRIMARY KEY CHECK(${text("id")}),
 actor_key TEXT NOT NULL CHECK(${text("actor_key")}),
 scenario TEXT NOT NULL CHECK(scenario IN ('workflow','script','web-bridge')),
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('workflow_draft','script_draft','browser_application')),
 owner_id TEXT NOT NULL CHECK(${safeId("owner_id")}),
 owner_scope_json TEXT NOT NULL CHECK(${object("owner_scope_json")}),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL CHECK(${text("model_id", 500)}),
 contract_version TEXT NOT NULL CHECK(${text("contract_version")}),
 tool_policy_version TEXT NOT NULL CHECK(${text("tool_policy_version")}),
 knowledge_hash TEXT NOT NULL CHECK(${hash("knowledge_hash")}),
 native_ref_json TEXT CHECK(${nullable("native_ref_json", object("native_ref_json"))}),
 native_ref_version INTEGER CHECK(${nullable("native_ref_version", integer("native_ref_version", 1))}),
 provider_fingerprint TEXT CHECK(${nullable("provider_fingerprint", hash("provider_fingerprint"))}),
 generation INTEGER NOT NULL CHECK(${integer("generation", 1)}),
 revision INTEGER NOT NULL CHECK(${integer("revision", 1)}),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleting','deleted')),
 native_delete_state TEXT NOT NULL CHECK(native_delete_state IN ('present','pending','unknown','absent')),
 created_at INTEGER NOT NULL CHECK(${integer("created_at")}),
 updated_at INTEGER NOT NULL CHECK(${integer("updated_at")}),
 UNIQUE(id,mode),
 CHECK((scenario='workflow' AND owner_kind='workflow_draft') OR (scenario='script' AND owner_kind='script_draft') OR (scenario='web-bridge' AND owner_kind='browser_application')),
 CHECK((native_ref_json IS NULL AND native_ref_version IS NULL AND provider_fingerprint IS NULL) OR (native_ref_json IS NOT NULL AND native_ref_version IS NOT NULL AND provider_fingerprint IS NOT NULL)),
 CHECK(mode!='single' OR (native_ref_json IS NULL AND native_delete_state='absent')),
 CHECK(native_delete_state!='absent' OR native_ref_json IS NULL),
 CHECK(native_delete_state!='present' OR native_ref_json IS NOT NULL),
 CHECK(lifecycle!='deleted' OR (native_delete_state='absent' AND native_ref_json IS NULL))
);
CREATE TABLE agent_maintenance_tasks (
 id TEXT NOT NULL PRIMARY KEY CHECK(${text("id")}),
 session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 request_id TEXT NOT NULL CHECK(${text("request_id")}),
 request_hash TEXT NOT NULL CHECK(${hash("request_hash")}),
 sequence INTEGER NOT NULL CHECK(${integer("sequence", 1)}),
 generation INTEGER NOT NULL CHECK(${integer("generation", 1)}),
 projection_generation INTEGER NOT NULL CHECK(${integer("projection_generation", 1)}),
 projection_hash TEXT NOT NULL CHECK(${hash("projection_hash")}),
 baseline_json TEXT NOT NULL CHECK(${object("baseline_json")}),
 status TEXT NOT NULL CHECK(status IN (${active},'succeeded','failed','cancelled','interrupted')),
 process_state TEXT NOT NULL CHECK(process_state IN ('absent','starting','running','stopping','stopped','unknown')),
 input_ref TEXT CHECK(${nullable("input_ref", object("input_ref"))}),
 display_output_ref TEXT CHECK(${nullable("display_output_ref", object("display_output_ref"))}),
 error_code TEXT CHECK(${nullable("error_code", text("error_code"))}),
 created_at INTEGER NOT NULL CHECK(${integer("created_at")}),
 started_at INTEGER CHECK(${nullable("started_at", integer("started_at"))}),
 ended_at INTEGER CHECK(${nullable("ended_at", integer("ended_at"))}),
 UNIQUE(id,session_id), UNIQUE(session_id,request_id), UNIQUE(session_id,sequence),
 FOREIGN KEY(session_id,mode) REFERENCES agent_maintenance_sessions(id,mode),
 CHECK(mode!='single' OR sequence=1),
 CHECK(status IN (${active}) OR (process_state IN ('absent','stopped') AND ended_at IS NOT NULL))
);
CREATE TABLE agent_maintenance_proposals (
 id TEXT NOT NULL PRIMARY KEY CHECK(${text("id")}),
 actor_key TEXT NOT NULL CHECK(${text("actor_key")}),
 session_id TEXT NOT NULL REFERENCES agent_maintenance_sessions(id) ON DELETE RESTRICT,
 task_id TEXT NOT NULL,
 submit_request_id TEXT NOT NULL CHECK(${text("submit_request_id")}),
 submit_request_hash TEXT NOT NULL CHECK(${hash("submit_request_hash")}),
 contract_version TEXT NOT NULL CHECK(${text("contract_version")}),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('workflow_draft','script_draft','browser_application')),
 target_id TEXT NOT NULL CHECK(${safeId("target_id")}),
 target_scope_json TEXT NOT NULL CHECK(${object("target_scope_json")}),
 baseline_json TEXT NOT NULL CHECK(${object("baseline_json")}),
 body_json TEXT NOT NULL CHECK(${object("body_json", 8 * 1024 * 1024)}),
 before_json TEXT NOT NULL CHECK(${object("before_json", 8 * 1024 * 1024)}),
 content_hash TEXT NOT NULL CHECK(${hash("content_hash")}),
 diff_hash TEXT NOT NULL CHECK(${hash("diff_hash")}),
 state TEXT NOT NULL CHECK(state IN ('pending','confirmed','revoked','applied','conflicted','expired')),
 created_at INTEGER NOT NULL CHECK(${integer("created_at")}),
 expires_at INTEGER NOT NULL CHECK(${integer("expires_at")} AND expires_at>created_at AND expires_at-created_at<=604800000),
 UNIQUE(actor_key,submit_request_id),
 FOREIGN KEY(task_id,session_id) REFERENCES agent_maintenance_tasks(id,session_id) ON DELETE RESTRICT
);
CREATE TABLE agent_maintenance_decisions (
 id TEXT NOT NULL PRIMARY KEY CHECK(${text("id")}),
 proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE CASCADE,
 actor_key TEXT NOT NULL CHECK(${text("actor_key")}),
 request_id TEXT NOT NULL CHECK(${text("request_id")}),
 action TEXT NOT NULL CHECK(action IN ('confirm','revoke')),
 content_hash TEXT NOT NULL CHECK(${hash("content_hash")}),
 diff_hash TEXT NOT NULL CHECK(${hash("diff_hash")}),
 created_at INTEGER NOT NULL CHECK(${integer("created_at")}),
 valid_until INTEGER CHECK(${nullable("valid_until", integer("valid_until"))}),
 UNIQUE(id,proposal_id), UNIQUE(actor_key,request_id), UNIQUE(proposal_id,action),
 CHECK((action='confirm' AND valid_until IS NOT NULL AND valid_until>created_at AND valid_until-created_at<=86400000) OR (action='revoke' AND valid_until IS NULL))
);
CREATE TABLE agent_maintenance_apply_requests (
 id TEXT NOT NULL PRIMARY KEY CHECK(${text("id")}),
 proposal_id TEXT NOT NULL REFERENCES agent_maintenance_proposals(id) ON DELETE RESTRICT,
 confirmation_id TEXT NOT NULL,
 actor_key TEXT NOT NULL CHECK(${text("actor_key")}),
 request_id TEXT NOT NULL CHECK(${text("request_id")}),
 request_hash TEXT NOT NULL CHECK(${hash("request_hash")}),
 state TEXT NOT NULL CHECK(state IN ('queued','applied','conflicted','rejected')),
 target_generation INTEGER CHECK(${nullable("target_generation", integer("target_generation", 1))}),
 result_json TEXT CHECK(${nullable("result_json", object("result_json"))}),
 error_code TEXT CHECK(${nullable("error_code", text("error_code"))}),
 retry_at INTEGER CHECK(${nullable("retry_at", integer("retry_at"))}),
 attempt_count INTEGER NOT NULL CHECK(${integer("attempt_count")}),
 created_at INTEGER NOT NULL CHECK(${integer("created_at")}),
 updated_at INTEGER NOT NULL CHECK(${integer("updated_at")}),
 settled_at INTEGER CHECK(${nullable("settled_at", integer("settled_at"))}),
 UNIQUE(actor_key,request_id),
 FOREIGN KEY(confirmation_id,proposal_id) REFERENCES agent_maintenance_decisions(id,proposal_id) ON DELETE RESTRICT,
 CHECK((state='queued' AND target_generation IS NULL AND result_json IS NULL AND settled_at IS NULL) OR (state!='queued' AND result_json IS NOT NULL AND settled_at IS NOT NULL)),
 CHECK((state='applied' AND target_generation IS NOT NULL) OR (state!='applied' AND target_generation IS NULL))
);
CREATE INDEX workspace_bindings_resource ON agent_workspace_workflow_bindings(resource_id,draft_id);
CREATE INDEX maintenance_sessions_owner ON agent_maintenance_sessions(actor_key,scenario,owner_kind,owner_id,updated_at,id);
CREATE INDEX maintenance_tasks_session ON agent_maintenance_tasks(session_id,sequence);
CREATE UNIQUE INDEX maintenance_one_project_task ON agent_maintenance_tasks((1)) WHERE status IN (${active});
CREATE UNIQUE INDEX maintenance_one_session_task ON agent_maintenance_tasks(session_id) WHERE status IN (${active});
CREATE UNIQUE INDEX maintenance_single_task ON agent_maintenance_tasks(session_id) WHERE mode='single';
CREATE INDEX maintenance_proposals_actor ON agent_maintenance_proposals(actor_key,state,created_at,id);
CREATE INDEX maintenance_proposals_session ON agent_maintenance_proposals(session_id,created_at,id);
CREATE INDEX maintenance_decisions_proposal ON agent_maintenance_decisions(proposal_id,created_at,id);
CREATE INDEX maintenance_apply_queue ON agent_maintenance_apply_requests(state,retry_at,created_at,id) WHERE state='queued';
CREATE UNIQUE INDEX maintenance_one_applied_proposal ON agent_maintenance_apply_requests(proposal_id) WHERE state='applied';

${noReplace("bridge_configuration")}
${noReplace("agent_workspace_workflow_bindings", "draft_id=NEW.draft_id")}
${noReplace("agent_workspace_projection_state")}
${noReplace("agent_maintenance_sessions")}
${noReplace("agent_maintenance_tasks", `id=NEW.id OR (session_id=NEW.session_id AND (request_id=NEW.request_id OR sequence=NEW.sequence OR (mode='single' AND NEW.mode='single'))) OR (NEW.status IN (${active}) AND status IN (${active}))`)}
${noReplace("agent_maintenance_proposals", "id=NEW.id OR (actor_key=NEW.actor_key AND submit_request_id=NEW.submit_request_id)")}
${noReplace("agent_maintenance_decisions", "id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id) OR (proposal_id=NEW.proposal_id AND action=NEW.action)")}
${noReplace("agent_maintenance_apply_requests", "id=NEW.id OR (actor_key=NEW.actor_key AND request_id=NEW.request_id)")}
${immutable("bridge_configuration", "revision_monotonic", [], "NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision")}
${immutable("agent_workspace_workflow_bindings", "identity_immutable", ["draft_id", "resource_id", "created_at"])}
${immutable("agent_workspace_projection_state", "generation_monotonic", [], "NEW.id IS NOT OLD.id OR NEW.target_generation<OLD.target_generation OR NEW.synced_generation<OLD.synced_generation")}
${immutable("agent_maintenance_sessions", "identity_immutable", ["id", "actor_key", "scenario", "owner_kind", "owner_id", "owner_scope_json", "mode", "provider_id", "contract_version", "tool_policy_version", "knowledge_hash", "created_at"])}
${immutable("agent_maintenance_sessions", "generation_monotonic", [], "NEW.generation<OLD.generation OR NEW.revision<OLD.revision")}
${immutable("agent_maintenance_tasks", "identity_immutable", ["id", "session_id", "mode", "request_id", "request_hash", "sequence", "generation", "projection_generation", "projection_hash", "baseline_json", "input_ref", "created_at"])}
${immutable("agent_maintenance_proposals", "content_immutable", ["id", "actor_key", "session_id", "task_id", "submit_request_id", "submit_request_hash", "contract_version", "target_kind", "target_id", "target_scope_json", "baseline_json", "body_json", "before_json", "content_hash", "diff_hash", "created_at", "expires_at"])}
${immutable("agent_maintenance_decisions", "decision_immutable", [], "1")}
${immutable("agent_maintenance_apply_requests", "identity_immutable", ["id", "proposal_id", "confirmation_id", "actor_key", "request_id", "request_hash", "created_at"])}
${immutable("agent_maintenance_apply_requests", "result_immutable", [], "OLD.state!='queued'")}

CREATE TRIGGER maintenance_session_lifecycle BEFORE UPDATE OF lifecycle ON agent_maintenance_sessions
WHEN (OLD.lifecycle='deleted' AND NEW.lifecycle!='deleted')
 OR (OLD.lifecycle='deleting' AND NEW.lifecycle='active')
 OR (NEW.lifecycle!='active' AND EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE session_id=OLD.id AND status IN (${active})))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_SESSION_BUSY'); END;
CREATE TRIGGER maintenance_session_delete BEFORE DELETE ON agent_maintenance_sessions
WHEN OLD.lifecycle!='deleted' OR OLD.native_delete_state!='absent'
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_DELETE_UNCONFIRMED'); END;
CREATE TRIGGER maintenance_task_admission BEFORE INSERT ON agent_maintenance_tasks
WHEN NEW.status IN (${active}) AND NOT EXISTS(
 SELECT 1 FROM agent_maintenance_sessions s,agent_workspace_projection_state p
 WHERE s.id=NEW.session_id AND s.lifecycle='active' AND s.native_delete_state IN ('present','absent') AND s.generation=NEW.generation
 AND p.id='maintenance' AND p.state='ready' AND p.synced_generation=NEW.projection_generation
 AND p.content_hash=NEW.projection_hash AND p.target_knowledge_hash=s.knowledge_hash)
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_TASK_BLOCKED'); END;
CREATE TRIGGER maintenance_task_no_reopen BEFORE UPDATE OF status ON agent_maintenance_tasks
WHEN OLD.status NOT IN (${active}) AND NEW.status IS NOT OLD.status
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
 EXISTS(SELECT 1 FROM agent_maintenance_tasks WHERE status IN (${active}))
 OR NOT EXISTS(SELECT 1 FROM agent_workspace_projection_state WHERE id='maintenance' AND target_generation=NEW.target_generation AND state IN ('pending','syncing'))
 OR NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions d JOIN agent_maintenance_proposals p ON p.id=d.proposal_id
 WHERE d.id=NEW.confirmation_id AND p.id=NEW.proposal_id AND d.action='confirm' AND p.state='confirmed'
 AND d.actor_key=NEW.actor_key AND p.actor_key=NEW.actor_key AND d.content_hash=p.content_hash AND d.diff_hash=p.diff_hash
 AND d.valid_until>NEW.updated_at AND p.expires_at>NEW.updated_at
 AND NOT EXISTS(SELECT 1 FROM agent_maintenance_decisions r WHERE r.proposal_id=p.id AND r.action='revoke')))
BEGIN SELECT RAISE(ABORT,'MAINTENANCE_APPLY_BLOCKED'); END;
`;
