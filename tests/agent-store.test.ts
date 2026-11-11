import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AGENT_RUNTIME_SCHEMA } from "../src/agent/schema.js";
import { AgentStore, type AgentMode } from "../src/agent/store.js";
import { AgentRuntime, type RuntimeSession } from "../src/agent/runtime.js";
import { ConversationLocks } from "../src/agent/locks.js";
import { SingleProviderHost } from "../src/agent/single-provider-host.js";
import { CliProvider } from "../src/providers/registry.js";
import { codexNativeAdapter } from "../src/providers/codex-app-server.js";
import { piNativeAdapter } from "../src/providers/pi-rpc.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { installFixture } from "./agent-fixtures.js";
import { setup as setupProviders } from "./helpers.js";
import { digest } from "../src/persistence/files.js";
import type { ReferenceValidator } from "../src/agent/provider-contract.js";
const hash = "a".repeat(64), fingerprint = "b".repeat(64);
const actor = "local";
const validator: ReferenceValidator = { providerId: "third-provider", supportedVersions: [7], validatePayload(value) { assert.deepEqual(value, { native: "private-locator" }); } };
const reference = { providerId: "third-provider", version: 7, opaque: { native: "private-locator" } };
function setup(t: TestContext) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE provider_settings(id TEXT NOT NULL PRIMARY KEY);
    INSERT INTO provider_settings VALUES('third-provider'),('other-provider');
    CREATE TABLE command_receipts(scope TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope,request_id));`);
  db.exec(AGENT_RUNTIME_SCHEMA);
  db.prepare("INSERT INTO agent_workspaces VALUES('maintenance','agent/workspace',?,'ready',1,1)").run(hash);
  const store = new AgentStore(db);
  const input = (mode: AgentMode = "multi") => ({ scenario: "test-maintenance", ownerType: "draft", ownerId: "owner", ownerScope: { draftVersionId: "fixed" }, mode, providerId: validator.providerId, modelId: "model-a", knowledgeHash: mode === "multi" ? hash : undefined, workspaceId: mode === "multi" ? "maintenance" : undefined, contractVersion: "1", toolPolicyVersion: "platform-read-v1" });
  const create = (mode: AgentMode = "multi", requestId = crypto.randomUUID()) => store.create(actor, requestId, input(mode)).conversation;
  const bind = (id: string, generation = 1, expectedGeneration = 0) => store.saveBackend(actor, id, { expectedRevision: store.conversation(actor, id).revision, expectedGeneration, generation, reference, fingerprint, validator });
  const send = (id: string, requestId = crypto.randomUUID()) => {
    const { turn } = store.submit(actor, id, { requestId, requestHash: digest(requestId) });
    const backend = store.backend(actor, id); if (!backend && turn.mode === "multi") bind(id);
    store.markSending(actor, turn.id, store.backend(actor, id)?.generation ?? 1);
    store.markAccepted(actor, turn.id, store.turn(actor, turn.id).generation);
    return store.turn(actor, turn.id);
  };
  const deletion = (id: string, requestId = "delete") => store.beginControl(actor, id, { kind: "delete", requestId, requestHash: digest(requestId), expectedRevision: store.conversation(actor, id).revision }).operation;
  return { db, store, input, create, bind, send, deletion };
}

test("approved schema contains nine unified tables and no fixed native CLI columns", t => {
  const { db } = setup(t);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'agent_%'").all();
  assert.equal(tables.length, 9);
  const columns = db.prepare("PRAGMA table_info(agent_backends)").all().map(row => row.name);
  for (const name of ["thread_id", "session_file", "session_id"]) assert.ok(!columns.includes(name));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("create idempotency binds content, actor and fixed owner/provider", t => {
  const { store, input, db } = setup(t);
  const first = store.create(actor, "create", input());
  assert.equal(first.created, true);
  assert.equal(store.create(actor, "create", input()).conversation.id, first.conversation.id);
  assert.throws(() => store.create(actor, "create", { ...input(), modelId: "other" }), { code: "REQUEST_CONFLICT" });
  assert.throws(() => store.conversation("other-actor", first.conversation.id), { code: "NOT_FOUND" });
  for (const [column, value] of [["provider_id", "other-provider"], ["mode", "single"], ["owner_id", "different"], ["knowledge_hash", fingerprint]]) {
    assert.throws(() => db.prepare(`UPDATE agent_conversations SET ${column}=? WHERE id=?`).run(value, first.conversation.id), /AGENT_IDENTITY_IMMUTABLE/);
  }
  db.prepare("UPDATE agent_workspaces SET installation_state='failed'").run();
  assert.throws(() => store.create(actor, "not-ready", input()), { code: "KNOWLEDGE_NOT_READY" });
});

test("single permits only one logical turn, duplicate request only returns original", t => {
  const { store, create, db } = setup(t), conversation = create("single");
  const request = { requestId: "r1", requestHash: hash };
  const first = store.submit(actor, conversation.id, request);
  assert.equal(first.created, true);
  assert.deepEqual(store.submit(actor, conversation.id, request), { turn: first.turn, created: false });
  assert.throws(() => store.submit(actor, conversation.id, { ...request, requestHash: fingerprint }), { code: "REQUEST_CONFLICT" });
  store.markSending(actor, first.turn.id, 1); store.markAccepted(actor, first.turn.id, 1);
  store.settle(actor, first.turn.id, { status: "succeeded", generation: 1 });
  assert.throws(() => store.submit(actor, conversation.id, { requestId: "r2", requestHash: fingerprint }), { code: "SINGLE_TURN_LIMIT" });
  assert.throws(() => db.prepare("DELETE FROM agent_turns WHERE id=?").run(first.turn.id), /AGENT_SINGLE_TURN_RETAINED/);
  assert.throws(() => db.prepare("UPDATE agent_turns SET request_hash=? WHERE id=?").run(fingerprint, first.turn.id), /AGENT_TURN_IDENTITY_IMMUTABLE/);
});

test("database rejects multiple active turns and mismatched modes even via direct SQL", t => {
  const { store, create, db } = setup(t), conversation = create();
  const first = store.submit(actor, conversation.id, { requestId: "one", requestHash: hash }).turn;
  assert.throws(() => store.submit(actor, conversation.id, { requestId: "two", requestHash: hash }), { code: "TURN_ACTIVE" });
  assert.throws(() => db.prepare(`INSERT INTO agent_turns SELECT 'second',conversation_id,mode,sequence+1,'other',request_hash,status,submission_state,requested_model_id,actual_model_id,model_source,generation,input_ref,proposal_ref,error_json,base_revision,read_baselines_json,apply_status,outcome_ref,created_at,started_at,ended_at FROM agent_turns WHERE id=?`).run(first.id), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE agent_turns SET mode='single' WHERE id=?").run(first.id), /AGENT_TURN_IDENTITY_IMMUTABLE/);
  assert.throws(() => db.prepare("UPDATE agent_conversations SET lifecycle='deleting' WHERE id=?").run(conversation.id), /AGENT_LIFECYCLE_CONFLICT/);
});

test("backend reference validation is provider-owned, save uses revision and generation CAS", t => {
  const { store, create, bind, db } = setup(t), conversation = create();
  const backend = bind(conversation.id);
  assert.equal(backend.ref_version, 7);
  assert.throws(() => store.saveBackend(actor, conversation.id, { expectedRevision: conversation.revision, expectedGeneration: 1, generation: 1, reference, fingerprint, validator }), { code: "BACKEND_BINDING_CONFLICT" });
  assert.throws(() => store.saveBackend(actor, conversation.id, { expectedRevision: store.conversation(actor, conversation.id).revision, expectedGeneration: 1, generation: 2, reference: { ...reference, version: 8 }, fingerprint, validator }), { code: "BACKEND_REFERENCE_VERSION_UNSUPPORTED" });
  assert.throws(() => db.prepare("UPDATE agent_backends SET generation=0 WHERE conversation_id=?").run(conversation.id), /AGENT_BACKEND_GENERATION_CONFLICT/);
  assert.throws(() => db.prepare("UPDATE agent_backends SET reference_json=? WHERE conversation_id=?").run(JSON.stringify({ ...reference, token: "forbidden" }), conversation.id), /AGENT_BACKEND_INVALID/);
  assert.throws(() => db.prepare("UPDATE agent_backends SET reference_json=? WHERE conversation_id=?").run('{"providerId":"third-provider","version":7}', conversation.id), /AGENT_BACKEND_INVALID/);
  assert.throws(() => db.prepare("UPDATE agent_backends SET reference_json='invalid' WHERE conversation_id=?").run(conversation.id), /AGENT_BACKEND_INVALID/);
});

test("single cannot persist a native backend, malformed metadata and unsafe runtime paths are rejected", t => {
  const { create, db, store } = setup(t), conversation = create("single");
  assert.throws(() => db.prepare("INSERT INTO agent_backends VALUES(?,?,?,?,?,1,'available','present',1)").run(conversation.id, validator.providerId, 7, JSON.stringify(reference), hash), /AGENT_BACKEND_INVALID/);
  assert.throws(() => db.prepare("UPDATE agent_conversations SET owner_scope_json='[]' WHERE id=?").run(conversation.id));
  const turn = store.submit(actor, conversation.id, { requestId: "r", requestHash: hash }).turn;
  assert.throws(() => db.prepare("INSERT INTO agent_runtime_resources VALUES(?,?,'single','instance',1,'stopped','pending',1,1)").run(turn.id, "agent/workspace"), /CHECK/);
});

test("acceptance and cancellation are separate from completion, sending is not repeated", t => {
  const { store, create, bind } = setup(t), conversation = create();
  const turn = store.submit(actor, conversation.id, { requestId: "r", requestHash: hash }).turn;
  assert.throws(() => store.settle(actor, turn.id, { generation: 0, status: "succeeded" }), { code: "SUBMISSION_CONFLICT" });
  bind(conversation.id); store.markSending(actor, turn.id, 1);
  assert.throws(() => store.markSending(actor, turn.id, 1), { code: "SUBMISSION_CONFLICT" });
  assert.equal(store.requestCancel(actor, turn.id).status, "cancel_requested");
  store.markAccepted(actor, turn.id, 1);
  assert.equal(store.turn(actor, turn.id).submission_state, "accepted");
  assert.throws(() => store.beginControl(actor, conversation.id, { kind: "delete", requestId: "d", requestHash: hash, expectedRevision: store.conversation(actor, conversation.id).revision }), { code: "TURN_ACTIVE" });
  store.settle(actor, turn.id, { generation: 1, status: "cancelled" });
  assert.equal(store.turn(actor, turn.id).submission_state, "settled");
  assert.throws(() => store.markAccepted(actor, turn.id, 1), { code: "SUBMISSION_CONFLICT" });
});

test("restart marks accepted/sending interrupted but never resubmits; stopped reconciliation is generation-bound", t => {
  const { store, create, send, deletion } = setup(t), conversation = create(), turn = send(conversation.id);
  assert.equal(store.recoverInterrupted(), 1);
  assert.equal(store.turn(actor, turn.id).status, "interrupted");
  assert.equal(store.turn(actor, turn.id).submission_state, "accepted");
  assert.equal(store.backend(actor, conversation.id)!.health, "unknown");
  assert.equal(store.submit(actor, conversation.id, { requestId: turn.request_id, requestHash: turn.request_hash }).created, false);
  assert.throws(() => store.submit(actor, conversation.id, { requestId: "new", requestHash: hash }), { code: "SUBMISSION_UNCERTAIN" });
  assert.throws(() => deletion(conversation.id), { code: "SUBMISSION_UNCERTAIN" });
  assert.throws(() => store.reconcileStopped(actor, turn.id, 2), { code: "TURN_GENERATION_CONFLICT" });
  store.reconcileStopped(actor, turn.id, 1);
  assert.equal(store.submit(actor, conversation.id, { requestId: "new", requestHash: hash }).created, true);
});

test("interrupted single can be deleted after its stopped generation is reconciled", t => {
  const { store, create, send, deletion } = setup(t), conversation = create("single"), turn = send(conversation.id);
  assert.equal(store.backend(actor, conversation.id), undefined);
  assert.equal(store.recoverInterrupted(), 1);
  assert.throws(() => deletion(conversation.id), { code: "SUBMISSION_UNCERTAIN" });
  assert.throws(() => store.reconcileStopped(actor, turn.id, turn.generation + 1), { code: "TURN_GENERATION_CONFLICT" });
  store.reconcileStopped(actor, turn.id, turn.generation);
  assert.equal(store.turn(actor, turn.id).submission_state, "settled");
  assert.equal(store.operation(actor, turn.id).status, "failed");
  const operation = deletion(conversation.id);
  store.confirmNativeDeleted(actor, operation.id);
  assert.equal(store.finalizeDelete(actor, operation.id).status, "succeeded");
});

test("model switch preserves native reference, requires confirmation, failure keeps old model", t => {
  const { store, create, bind } = setup(t), conversation = create(); bind(conversation.id);
  const input = (requestId: string) => ({ kind: "switch_model" as const, requestId, requestHash: digest(requestId), expectedRevision: store.conversation(actor, conversation.id).revision, requestedModelId: "model-b" });
  const first = store.beginControl(actor, conversation.id, input("switch-1")).operation;
  assert.equal(store.conversation(actor, conversation.id).current_model_id, "model-a");
  assert.throws(() => store.submit(actor, conversation.id, { requestId: "r", requestHash: hash }), { code: "OPERATION_ACTIVE" });
  assert.throws(() => store.finishModelSwitch(actor, first.id, { confirmedModelId: "wrong-model" }), { code: "MODEL_SWITCH_UNCONFIRMED" });
  store.finishModelSwitch(actor, first.id, { error: { code: "MODEL_UNAVAILABLE" } });
  assert.equal(store.conversation(actor, conversation.id).current_model_id, "model-a");
  const second = store.beginControl(actor, conversation.id, input("switch-2")).operation;
  store.finishModelSwitch(actor, second.id, { confirmedModelId: "model-b" });
  assert.equal(store.conversation(actor, conversation.id).current_model_id, "model-b");
  assert.deepEqual(JSON.parse(store.backend(actor, conversation.id)!.reference_json), reference);
});

test("delete removes content only after native confirmation and keeps minimal idempotent receipt", t => {
  const { store, create, send, deletion, db, input } = setup(t), conversation = store.create(actor, "stable-create", input()).conversation;
  const other = create(), turn = send(conversation.id);
  store.appendEvent(actor, conversation.id, { eventId: "message", type: "message", turnId: turn.id, generation: 1, role: "assistant", payloadRef: "secret body" });
  store.settle(actor, turn.id, { generation: 1, status: "succeeded", proposalRef: "old proposal" });
  store.enqueueFeedback(actor, conversation.id, { eventId: "feedback", generation: 1, type: "resource_changed", payload: { revision: "2" } });
  const operation = deletion(conversation.id);
  assert.throws(() => store.finalizeDelete(actor, operation.id), { code: "NATIVE_DELETE_UNCONFIRMED" });
  assert.throws(() => store.controlProgress(actor, operation.id, { status: "running", phase: "provider_confirmed" }), { code: "NATIVE_DELETE_UNCONFIRMED" });
  assert.throws(() => store.submit(actor, conversation.id, { requestId: "new", requestHash: hash }), { code: "CONVERSATION_READ_ONLY" });
  assert.throws(() => db.prepare("DELETE FROM agent_conversations WHERE id=?").run(conversation.id), /AGENT_DELETE_UNCONFIRMED/);
  store.confirmNativeDeleted(actor, operation.id);
  const receipt = store.finalizeDelete(actor, operation.id);
  assert.equal(receipt.status, "succeeded"); assert.equal(receipt.conversation_id, null); assert.equal(receipt.target_reference_json, null);
  assert.equal(JSON.stringify(receipt).includes("secret body"), false);
  assert.deepEqual(store.finalizeDelete(actor, operation.id), receipt);
  assert.equal(store.beginControl(actor, conversation.id, { kind: "delete", requestId: "delete", requestHash: digest("delete"), expectedRevision: 1 }).created, false);
  assert.throws(() => store.create(actor, "stable-create", input()), { code: "CONVERSATION_DELETED" });
  assert.throws(() => store.conversation(actor, conversation.id), { code: "NOT_FOUND" });
  assert.equal(store.conversation(actor, other.id).id, other.id);
  for (const table of ["agent_events", "agent_turns", "agent_backends", "agent_host_feedback"]) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE conversation_id=?`).get(conversation.id)!.n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("delete failure keeps reference and cannot rollback to active; resources must be released", t => {
  const { store, create, send, deletion, db } = setup(t), conversation = create(), turn = send(conversation.id);
  store.settle(actor, turn.id, { generation: 1, status: "failed" });
  db.prepare("INSERT INTO agent_runtime_resources VALUES(?,?,'provider_private','instance',1,'unknown','retained',1,1)").run(turn.id, `agent/runtime/${turn.id}`);
  const operation = deletion(conversation.id);
  store.controlProgress(actor, operation.id, { status: "unknown", phase: "provider_pending", error: { code: "TIMEOUT" } });
  assert.deepEqual(JSON.parse(store.operation(actor, operation.id).target_reference_json!), reference);
  assert.throws(() => db.prepare("UPDATE agent_conversations SET lifecycle='active' WHERE id=?").run(conversation.id), /AGENT_LIFECYCLE_CONFLICT/);
  store.confirmNativeDeleted(actor, operation.id);
  assert.throws(() => store.finalizeDelete(actor, operation.id), { code: "RESOURCE_RELEASE_PENDING" });
  assert.equal(store.operation(actor, operation.id).phase, "provider_confirmed");
  db.prepare("UPDATE agent_runtime_resources SET process_state='stopped',release_state='released' WHERE operation_id=?").run(turn.id);
  assert.equal(store.finalizeDelete(actor, operation.id).status, "succeeded");
});

test("current revision must be queried, apply compares inside transaction and emits one durable fact", t => {
  const { store, create, send, db } = setup(t), conversation = create(), turn = send(conversation.id);
  assert.throws(() => store.recordProposalBaseline(actor, turn.id, "1"), { code: "BASELINE_NOT_QUERIED" });
  store.recordCurrentRead(actor, turn.id, 1, "1");
  store.recordProposalBaseline(actor, turn.id, "1");
  store.settle(actor, turn.id, { generation: 1, status: "succeeded", proposalRef: "complete proposal", applyStatus: "pending" });
  let revision = "2", applied = 0;
  const host = { currentRevision: () => revision, apply: () => { applied++; revision = "3"; return { newRevision: revision, outcomeRef: "business-version-3" }; } };
  assert.throws(() => store.applyProposal(actor, turn.id, host), { code: "REVISION_CONFLICT" }); assert.equal(applied, 0);
  revision = "1";
  assert.equal(store.applyProposal(actor, turn.id, host).applied, true);
  assert.equal(store.applyProposal(actor, turn.id, host).applied, false); assert.equal(applied, 1);
  const feedback = store.pendingFeedback(actor, conversation.id); assert.equal(feedback.length, 1);
  assert.deepEqual(JSON.parse(String(feedback[0]!.payload_json)), { revision: "3" });
  assert.equal(db.prepare("SELECT apply_status FROM agent_turns WHERE id=?").get(turn.id)!.apply_status, "applied");
});

test("outbox deduplicates event IDs and preserves unknown delivery instead of blindly resetting", t => {
  const { store, create } = setup(t), conversation = create();
  const input = { eventId: "fact", generation: 0, type: "resource_changed" as const, payload: { revision: "1" } };
  assert.equal(store.enqueueFeedback(actor, conversation.id, input), true);
  assert.equal(store.enqueueFeedback(actor, conversation.id, input), false);
  assert.throws(() => store.enqueueFeedback(actor, conversation.id, { ...input, payload: { revision: "2" } }), { code: "REQUEST_CONFLICT" });
  assert.throws(() => store.feedbackReceipt(actor, conversation.id, "fact", { status: "delivered", receipt: {} }), { code: "FEEDBACK_UNCONFIRMED" });
  store.feedbackReceipt(actor, conversation.id, "fact", { status: "unknown" });
  assert.equal(store.pendingFeedback(actor, conversation.id)[0]!.status, "unknown");
  store.feedbackReceipt(actor, conversation.id, "fact", { status: "delivered", receipt: { eventId: "fact", confirmed: true } });
  store.feedbackReceipt(actor, conversation.id, "fact", { status: "delivered", receipt: { eventId: "fact", confirmed: true } });
  assert.throws(() => store.feedbackReceipt(actor, conversation.id, "fact", { status: "unknown" }), { code: "FEEDBACK_ALREADY_DELIVERED" });
  assert.deepEqual(store.pendingFeedback(actor, conversation.id), []);
});

test("event cursors are stable and deduplicated, late/wrong-generation events cannot be reassigned", t => {
  const { store, create, send } = setup(t), conversation = create(), turn = send(conversation.id);
  const event = { eventId: "delta-1", type: "text", turnId: turn.id, generation: 1, payloadRef: "text" };
  assert.deepEqual(store.appendEvent(actor, conversation.id, event), { sequence: 1, created: true });
  assert.deepEqual(store.appendEvent(actor, conversation.id, event), { sequence: 1, created: false });
  assert.throws(() => store.appendEvent(actor, conversation.id, { ...event, payloadRef: "changed" }), { code: "REQUEST_CONFLICT" });
  assert.throws(() => store.appendEvent(actor, conversation.id, { ...event, eventId: "late", generation: 9 }), { code: "TURN_GENERATION_CONFLICT" });
  store.appendEvent(actor, conversation.id, { ...event, eventId: "delta-2" });
  assert.equal(store.events(actor, conversation.id, 1).length, 1);
  assert.equal(store.events(actor, conversation.id, 1)[0]!.event_id, "delta-2");
  assert.throws(() => store.events("other", conversation.id), { code: "NOT_FOUND" });
});

test("business application and outbox insert roll back together on failure", t => {
  const { store, create, send, db } = setup(t), conversation = create(), turn = send(conversation.id);
  db.exec("CREATE TABLE test_business_revision(id TEXT PRIMARY KEY,revision INTEGER); INSERT INTO test_business_revision VALUES('asset',1);");
  store.recordCurrentRead(actor, turn.id, 1, "1"); store.recordProposalBaseline(actor, turn.id, "1");
  store.settle(actor, turn.id, { generation: 1, status: "succeeded", proposalRef: "proposal", applyStatus: "pending" });
  const host = { currentRevision: () => String(db.prepare("SELECT revision FROM test_business_revision").get()!.revision), apply: () => {
    db.prepare("UPDATE test_business_revision SET revision=2 WHERE id='asset' AND revision=1").run();
    return { newRevision: "2", outcomeRef: "business-version" };
  } };
  db.exec("CREATE TRIGGER fail_feedback BEFORE INSERT ON agent_host_feedback BEGIN SELECT RAISE(ABORT,'injected feedback failure'); END;");
  assert.throws(() => store.applyProposal(actor, turn.id, host), /injected feedback failure/);
  assert.equal(host.currentRevision(), "1"); assert.equal(store.turn(actor, turn.id).apply_status, "pending");
  db.exec("DROP TRIGGER fail_feedback;");
  assert.equal(store.applyProposal(actor, turn.id, host).applied, true);
  assert.equal(host.currentRevision(), "2"); assert.equal(store.pendingFeedback(actor, conversation.id).length, 1);
});

test("platform-delete failure retains operation and content for forward recovery after native deletion", t => {
  const { store, create, send, deletion, db } = setup(t), conversation = create(), turn = send(conversation.id);
  store.settle(actor, turn.id, { generation: 1, status: "succeeded", proposalRef: "proposal" });
  store.appendEvent(actor, conversation.id, { eventId: "preserved-on-failure", type: "message", generation: 1, turnId: turn.id });
  const operation = deletion(conversation.id); store.confirmNativeDeleted(actor, operation.id);
  db.exec("CREATE TRIGGER fail_platform_delete BEFORE DELETE ON agent_conversations BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END;");
  assert.throws(() => store.finalizeDelete(actor, operation.id), /injected deletion failure/);
  assert.equal(store.operation(actor, operation.id).phase, "provider_confirmed");
  assert.equal(store.operation(actor, operation.id).conversation_id, conversation.id);
  assert.deepEqual(JSON.parse(store.operation(actor, operation.id).target_reference_json!), reference);
  assert.equal(store.events(actor, conversation.id).length, 1);
  assert.equal(store.backend(actor, conversation.id)!.native_delete_state, "absent");
  db.exec("DROP TRIGGER fail_platform_delete;");
  assert.equal(store.finalizeDelete(actor, operation.id).status, "succeeded");
});

test("Agent Store requires foreign keys and rejects asynchronous transaction callbacks", t => {
  const { db, store } = setup(t);
  db.exec("PRAGMA foreign_keys=OFF;");
  assert.throws(() => new AgentStore(db), { code: "AGENT_FOREIGN_KEYS_REQUIRED" });
  db.exec("PRAGMA foreign_keys=ON;");
  assert.throws(() => store.transaction(() => Promise.resolve("not allowed")), { code: "ASYNC_TRANSACTION_FORBIDDEN" });
  assert.equal(store.transaction(() => "sync"), "sync");
});

test("deleting an interrupted unsent single also settles detached operations without preserving content", t => {
  const { create, store, deletion, db } = setup(t), conversation = create("single");
  store.submit(actor, conversation.id, { requestId: "never-sent", requestHash: hash, inputRef: "must disappear" });
  store.recoverInterrupted();
  const operation = deletion(conversation.id);
  store.confirmNativeDeleted(actor, operation.id);
  store.finalizeDelete(actor, operation.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_operations WHERE subject_id=? AND settled_at IS NULL").get(conversation.id)!.n, 0);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM agent_operations WHERE subject_id=?").all(conversation.id)).includes("must disappear"), false);
});

test("knowledge update waits for old readers, marks old multi read-only and leaves single unchanged", t => {
  const { store, create, send } = setup(t), multi = create(), single = create("single"), turn = send(multi.id);
  assert.throws(() => store.markKnowledgeOutdated(fingerprint), { code: "WORKSPACE_BUSY" });
  store.settle(actor, turn.id, { generation: 1, status: "succeeded" });
  assert.equal(store.markKnowledgeOutdated(fingerprint), 1);
  assert.equal(store.conversation(actor, multi.id).usability, "knowledge_outdated");
  assert.equal(store.conversation(actor, single.id).usability, "usable");
  assert.throws(() => store.submit(actor, multi.id, { requestId: "new", requestHash: hash }), { code: "CONVERSATION_READ_ONLY" });
  assert.equal(store.beginControl(actor, multi.id, { kind: "delete", requestId: "delete-old", requestHash: hash, expectedRevision: store.conversation(actor, multi.id).revision }).created, true);
});

for (const kind of ["delete", "switch_model"] as const) {
  test(`knowledge upgrade preserves the revision for an unfinished ${kind} and can retry after recovery`, t => {
    const { store, create, bind } = setup(t), target = create(), other = create();
    bind(target.id);
    const { operation } = store.beginControl(actor, target.id, {
      kind, requestId: kind, requestHash: hash, expectedRevision: store.conversation(actor, target.id).revision,
      requestedModelId: kind === "switch_model" ? "model-b" : undefined,
    });
    store.recoverInterrupted();
    assert.throws(() => store.markKnowledgeOutdated(fingerprint), { code: "WORKSPACE_BUSY" });
    assert.equal(store.conversation(actor, target.id).revision, operation.expected_revision);
    assert.equal(store.conversation(actor, other.id).usability, "usable");
    if (kind === "delete") {
      store.confirmNativeDeleted(actor, operation.id);
      assert.equal(store.finalizeDelete(actor, operation.id).status, "succeeded");
    } else {
      store.finishModelSwitch(actor, operation.id, { error: { code: "INTERRUPTED" } });
      assert.equal(store.conversation(actor, target.id).current_model_id, "model-a");
    }
    assert.equal(store.markKnowledgeOutdated(fingerprint), kind === "delete" ? 1 : 2);
    assert.equal(store.conversation(actor, other.id).usability, "knowledge_outdated");
  });
}

test("runtime persists the native binding and a queried proposal once across idempotent submissions", async t => {
  const { store, create } = setup(t), conversation = create();
  let sends = 0;
  const runtime = new AgentRuntime(store, new ConversationLocks(), {
    async authorize() {},
    async withSession({ turn }, run) {
      return run({
        generation: 1, binding: { reference, fingerprint, validator },
        async send({ accepted }) {
          sends++;
          accepted();
          store.recordCurrentRead(actor, turn.id, 1, "resource-rev");
          return { proposalRef: "proposal", baseRevision: "resource-rev", actualModelId: "model-a", modelSource: "reported" };
        },
        async stop() { return true; },
      });
    },
  });
  const signal = new AbortController().signal;
  const input = { requestId: "turn", requestHash: hash };
  const [first, second] = await Promise.all([runtime.submit(actor, conversation.id, input, signal), runtime.submit(actor, conversation.id, input, signal)]);
  assert.equal(first.turn.id, second.turn.id);
  const settled = await runtime.wait(actor, first.turn.id);
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.apply_status, "pending");
  assert.equal(store.backend(actor, conversation.id)?.generation, 1);
  assert.equal(sends, 1);
});

test("runtime cancellation without a stop proof keeps the native submission uncertain", async t => {
  const { store, create, deletion } = setup(t), conversation = create("single");
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const runtime = new AgentRuntime(store, new ConversationLocks(), {
    async authorize() {},
    async withSession(_, run) {
      const session: RuntimeSession = {
        generation: 1,
        async send({ signal, accepted }) {
          accepted();
          notifyStarted();
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
          signal.throwIfAborted();
          return {};
        },
        async stop() { return false; },
      };
      return run(session);
    },
  });
  const { turn } = await runtime.submit(actor, conversation.id, { requestId: "turn", requestHash: hash }, new AbortController().signal);
  await started;
  const result = await runtime.cancel(actor, turn.id);
  assert.equal(result.status, "interrupted");
  assert.equal(result.submission_state, "accepted");
  assert.equal(store.operation(actor, turn.id).status, "unknown");
  assert.throws(() => deletion(conversation.id), { code: "SUBMISSION_UNCERTAIN" });
});

test("unified single execution uses Codex and Pi native adapters through the Registry", async t => {
  const { db, store, input } = setup(t);
  const platform = setupProviders(t);
  t.after(() => platform.store.close());
  const manager = new SessionManager();
  t.after(() => manager.close());
  for (const id of ["codex-cli", "pi-cli"] as const) {
    const { executable } = installFixture(t, id === "codex-cli" ? "codex-server.mjs" : "pi-server.mjs", "default");
    const native = id === "codex-cli" ? codexNativeAdapter(manager, manager.limits) : piNativeAdapter(manager, manager.limits);
    platform.providers.register(new CliProvider(id, { native }), executable);
    platform.providers.update(id, { enabled: true, defaultModel: "fixture/small" });
    db.prepare("INSERT INTO provider_settings VALUES(?)").run(id);
    const { conversation } = store.create(actor, id, { ...input("single"), providerId: id, modelId: "fixture/small" });
    let output: unknown;
    const host = new SingleProviderHost(platform.providers, async () => {}, async () => ({
      request: { cwd: platform.root, prompt: 'RETURN:{"answer":42}', schema: { type: "object" }, emit: () => {} },
      async recordResult(result) { output = result.output; },
    }));
    const runtime = new AgentRuntime(store, new ConversationLocks(), host);
    const { turn } = await runtime.submit(actor, conversation.id, { requestId: "single", requestHash: hash }, AbortSignal.timeout(15_000));
    const result = await runtime.wait(actor, turn.id);
    assert.equal(result.status, "succeeded", result.error_json ?? "native turn did not succeed");
    assert.deepEqual(output, { answer: 42 });
    assert.equal(store.backend(actor, conversation.id), undefined);
  }
});
