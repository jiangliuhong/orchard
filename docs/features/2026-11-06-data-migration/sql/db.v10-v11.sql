
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
