import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, temporary } from "./helpers.js";
import { canonicalJson, digest, FileStore } from "../src/persistence/files.js";
import { Store } from "../src/persistence/store.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import { RUN_SCHEMA } from "../src/persistence/schema.js";

const legacyRunSchema = `
CREATE TABLE runs (
 id TEXT PRIMARY KEY, workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),
 input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,
 created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
`;

// 冻结的 v2 库结构（git 历史快照，RUN_SCHEMA 不变），用于构造旧版本数据库做升级测试。
const SCHEMA_V2 = `
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
 base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE UNIQUE INDEX one_active_turn ON authoring_turns(draft_id) WHERE status='running';
CREATE TABLE authoring_messages (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),
 sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(draft_id,sequence)
);
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
PRAGMA application_id = 1331110449;
PRAGMA user_version = 2;
`;

test("approved schema has thirteen tables and isolates unknown databases", t => {
  const root = temporary(t), store = new Store(root);
  assert.equal(store.all("SELECT name FROM sqlite_master WHERE type='table'").length, 13);
  assert.throws(() => new Store(root), /已有/); store.close();
  const unknownRoot = temporary(t), database = new DatabaseSync(join(unknownRoot, "workbench.db"));
  database.exec("CREATE TABLE old_data(id TEXT)"); database.close();
  assert.throws(() => new Store(unknownRoot), /未知数据库/);
});
test("commands are transactional and keyed by request content", t => {
  const { store } = setup(t); t.after(() => store.close());
  let calls = 0;
  assert.deepEqual(store.command("test", "key", { a: 1 }, () => ({ id: ++calls })), { id: 1 });
  assert.deepEqual(store.command("test", "key", { a: 1 }, () => ({ id: ++calls })), { id: 1 });
  assert.throws(() => store.command("test", "key", { a: 2 }, () => 3), /不同内容/);
  assert.throws(() => store.command("failed", "key", {}, () => { throw new Error("rollback"); }));
  assert.equal(store.one("SELECT * FROM command_receipts WHERE scope='failed'"), undefined);
  const ordered = store.command("ordering", "key", { a: 1, b: 2 }, () => true);
  assert.equal(store.command("ordering", "key", { b: 2, a: 1 }, () => false), ordered);
});
test("events emit only after commit and references verify artifact integrity", async t => {
  const { store, authoring } = setup(t); t.after(() => store.close());
  const draft = await authoring.create(undefined, randomUUID());
  const runId = randomUUID();
  // Use a turn stream to exercise foreign-key and stream ownership validation.
  store.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at) VALUES(?,?,?,'test-model',1,'running',0,?)", runId, draft.id, "test-provider", Date.now());
  const seen: number[] = []; store.events.on("event", event => seen.push(event.sequence));
  assert.throws(() => store.transaction(() => { store.append("authoring_turn", runId, "test", {}); throw new Error("rollback"); }));
  assert.equal(seen.length, 0); assert.equal(store.stream("authoring_turn", runId).length, 0);
  const big = "x".repeat(50000); store.append("authoring_turn", runId, "test", { big });
  assert.deepEqual(seen, [1]); assert.deepEqual(store.stream("authoring_turn", runId)[0]!.payload, { big });
  store.events.on("event", () => { throw new Error("disconnected subscriber"); });
  assert.doesNotThrow(() => store.append("authoring_turn", runId, "committed", {}));
  assert.equal(store.lastSequence("authoring_turn", runId), 2);
  assert.throws(() => store.append("run", "missing", "bad", {}), /不存在/);
});

test("schema v1 upgrades atomically and preserves runs, node references, events, artifacts and request receipts", t => {
  const root = temporary(t), now = Date.now();
  const versionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID(), nodeId = randomUUID(), attemptId = randomUUID();
  const database = new DatabaseSync(join(root, "workbench.db"));
  database.exec(SCHEMA_V2.replace(RUN_SCHEMA, legacyRunSchema).replace("PRAGMA user_version = 2", "PRAGMA user_version = 1"));
  const insert = (sql: string, ...params: SQLInputValue[]) => database.prepare(sql).run(...params);
  insert("INSERT INTO provider_settings(id,enabled,config_json,models_json,default_model,revision,updated_at) VALUES('test-provider',1,'{}','[]','',1,0)");
  insert("INSERT INTO workflows(id,name,created_at,updated_at) VALUES(?,?,?,?)", workflowId, "迁移工作流", now, now);
  insert("INSERT INTO workflow_versions(id,workflow_id,version_no,definition_json,layout_json,artifact_path,content_hash,created_at) VALUES(?,?,1,'{}','{}','unused','hash',?)", versionId, workflowId, now);
  insert("UPDATE workflows SET current_version_id=? WHERE id=?", versionId, workflowId);
  const input = { text: "x".repeat(50000) }, blob = new FileStore(root).writeBlob(input);
  insert("INSERT INTO artifacts VALUES(?,?,?,?,?,?)", blob.id, blob.relativePath, blob.hash, blob.size, "application/json", now);
  const inputRef = JSON.stringify({ artifactId: blob.id }), outputRef = JSON.stringify({ inline: { done: true } });
  insert("INSERT INTO runs(id,workflow_version_id,status,input_ref,output_ref,created_at,started_at,ended_at) VALUES(?,?,'succeeded',?,?,?,?,?)", runId, versionId, inputRef, outputRef, now, now, now);
  insert("INSERT INTO node_runs(id,run_id,node_id,type,status,started_at,ended_at) VALUES(?,?,'a','code.nodejs','succeeded',?,?)", nodeId, runId, now, now);
  insert("INSERT INTO node_attempts(id,node_run_id,attempt_no,status,execution_json,started_at) VALUES(?,?,1,'succeeded','{}',?)", attemptId, nodeId, now);
  insert("INSERT INTO stream_events(stream_type,stream_id,sequence,event_type,payload_ref,created_at) VALUES('run',?,1,'run.succeeded',?,?)", runId, JSON.stringify({ inline: { output: { ok: true } } }), now);
  insert("INSERT INTO command_receipts(scope,request_id,request_hash,result_json,created_at) VALUES('migration-test','request',?,?,?)", digest(canonicalJson({})), JSON.stringify({ id: runId }), now);
  database.close();
  const upgraded = new Store(root);
  assert.equal(upgraded.one("PRAGMA user_version")!.user_version, 3);
  assert.equal(upgraded.one("PRAGMA foreign_keys")!.foreign_keys, 1);
  assert.deepEqual(upgraded.all("PRAGMA foreign_key_check"), []);
  assert.deepEqual(upgraded.run(runId), { id: runId, workflowVersionId: versionId, draftId: null, draftRevision: null, snapshotPath: null, status: "succeeded", input, output: { done: true }, activeNodeId: null, error: undefined, createdAt: now, startedAt: now, endedAt: now });
  assert.deepEqual(upgraded.nodes(runId), [{ id: nodeId, runId, nodeId: "a", type: "code.nodejs", status: "succeeded", input: undefined, output: undefined, route: undefined, skipReason: null, error: undefined, startedAt: now, endedAt: now }]);
  assert.equal(upgraded.attempts(runId).length, 1);
  assert.deepEqual(upgraded.stream("run", runId).map(event => ({ type: event.type, payload: event.payload })), [{ type: "run.succeeded", payload: { output: { ok: true } } }]);
  assert.equal(upgraded.version(versionId).workflowId, workflowId);
  assert.deepEqual(upgraded.command("migration-test", "request", {}, () => assert.fail("receipt lost")), { id: runId });
  assert.throws(() => upgraded.exec("INSERT INTO runs(id,status,input_ref,created_at) VALUES('missing-source','queued','{}',0)"), /CHECK/);
  assert.throws(() => upgraded.exec("INSERT INTO runs(id,workflow_version_id,draft_id,draft_revision,snapshot_path,status,input_ref,created_at) VALUES('mixed',?,?,0,'snapshot','queued','{}',0)", versionId, "missing"), /CHECK/);
  upgraded.close();
  const reopened = new Store(root);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.run(runId).output, { done: true });
  assert.deepEqual(reopened.run(runId).input, input);
  assert.equal(reopened.one("SELECT id FROM artifacts WHERE id=?", blob.id)!.id, blob.id);
});

test("failed v1 migration rolls back the table, schema version and index", t => {
  const root = temporary(t), database = new DatabaseSync(join(root, "workbench.db"));
  database.exec(SCHEMA_V2.replace(RUN_SCHEMA, legacyRunSchema).replace("PRAGMA user_version = 2", "PRAGMA user_version = 1"));
  database.exec("PRAGMA foreign_keys=OFF; INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES('orphan','missing-version','queued','{}',0)");
  database.close();
  assert.throws(() => new Store(root), /升级外键校验失败/);
  const original = new DatabaseSync(join(root, "workbench.db"));
  t.after(() => original.close());
  assert.equal(original.prepare("PRAGMA user_version").get()!.user_version, 1);
  assert.equal(original.prepare("SELECT id FROM runs").get()!.id, "orphan");
  assert.ok(original.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='queued_runs'").get());
  assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE name='runs_v2'").get(), undefined);
  assert.equal(original.prepare("PRAGMA table_info(runs)").all().some(column => column.name === "draft_id"), false);
  // v3 增量迁移未执行：对话表不存在。
  assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE name='agent_conversations'").get(), undefined);
});

const conversationTableColumns = (store: Store) =>
  store.all("PRAGMA table_info(agent_conversations)").map(column => `${column.name}:${column.type}:${column.notnull}`);
const turnColumns = (store: Store) =>
  store.all("PRAGMA table_info(authoring_turns)").map(column => `${column.name}:${column.type}:${column.notnull}`);
const indexNames = (store: Store) =>
  store.all("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").map(row => String(row.name)).sort();

test("v2 databases upgrade to an equivalent v3 schema and old rows keep NULL associations", t => {
  const root = temporary(t), now = Date.now();
  const legacyTurnId = randomUUID();
  const legacy = new DatabaseSync(join(root, "workbench.db"));
  legacy.exec(SCHEMA_V2);
  const insert = (sql: string, ...params: SQLInputValue[]) => legacy.prepare(sql).run(...params);
  legacy.exec("INSERT INTO provider_settings(id,enabled,config_json,models_json,default_model,revision,updated_at) VALUES('test-provider',1,'{}','[]','',1,0)");
  insert("INSERT INTO drafts(id,workflow_id,base_version_id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES('draft-v2',NULL,NULL,0,'unused','{}','draft',?,?)", now, now);
  insert("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at) VALUES(?,?,'test-provider','test-model',1,'succeeded',0,?)", legacyTurnId, "draft-v2", now);
  insert("INSERT INTO authoring_messages(id,draft_id,turn_id,sequence,role,content_json,created_at) VALUES('msg-1','draft-v2',?,1,'user',?,?)", legacyTurnId, JSON.stringify({ text: "旧请求" }), now);
  insert("INSERT INTO authoring_messages(id,draft_id,turn_id,sequence,role,content_json,created_at) VALUES('msg-2','draft-v2',NULL,2,'user',?,?)", JSON.stringify({ text: "无轮次消息" }), now);
  legacy.close();
  const upgraded = new Store(root);
  t.after(() => upgraded.close());
  assert.equal(upgraded.one("PRAGMA user_version")!.user_version, 3);
  assert.deepEqual(upgraded.all("PRAGMA foreign_key_check"), []);
  // 旧行保留且关联为 NULL；不自动创建对话。
  assert.equal(upgraded.one("SELECT conversation_id FROM authoring_turns WHERE id=?", legacyTurnId)!.conversation_id, null);
  assert.equal(upgraded.conversations("draft-v2").length, 0);
  assert.equal(upgraded.messages("draft-v2").length, 2);
  assert.equal(upgraded.messages("draft-v2", null).length, 2);
  // 新库与升级库结构等价：对话表列、轮次列、索引集合一致。
  const freshRoot = temporary(t), fresh = new Store(freshRoot); t.after(() => fresh.close());
  assert.deepEqual(conversationTableColumns(upgraded), conversationTableColumns(fresh));
  assert.deepEqual(turnColumns(upgraded), turnColumns(fresh));
  assert.deepEqual(indexNames(upgraded).filter(name => name !== "queued_runs"), indexNames(fresh).filter(name => name !== "queued_runs"));
});

test("one active turn per draft covers queued, running and cancel_requested", async t => {
  const { store, authoring } = setup(t); t.after(() => store.close());
  const draft = await authoring.create(undefined, randomUUID());
  const insert = (id: string, status: string) => store.exec(
    "INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at) VALUES(?,?,?,'m',1,?,?,?)", id, draft.id, "test-provider", status, 0, Date.now());
  insert("queued-turn", "queued");
  assert.throws(() => insert("second", "queued"), /UNIQUE/);
  assert.throws(() => insert("second", "running"), /UNIQUE/);
  assert.throws(() => insert("second", "cancel_requested"), /UNIQUE/);
  // 终态不占用活动名额。
  store.exec("UPDATE authoring_turns SET status='cancelled',ended_at=? WHERE id='queued-turn'", Date.now());
  insert("second", "running");
  assert.equal(store.turns(draft.id).length, 2);
});

test("conversation writes validate cross-draft and turn ownership, deletion clears self references", async t => {
  const { store, authoring } = setup(t); t.after(() => store.close());
  const draftA = await authoring.create(undefined, randomUUID());
  const draftB = await authoring.create(undefined, randomUUID());
  const now = Date.now();
  const conversationId = randomUUID();
  store.insertConversation({ id: conversationId, draftId: draftA.id, mode: "multi", contextMode: "reconstructed", status: "current", providerId: "test-provider", providerRevision: 1, modelId: "test-model", transport: "legacy", connectionFingerprint: "fp", cliVersion: null, backendRef: null, backendGeneration: 0, syncedRevision: null, rebuildFromId: null, createdAt: now, lastUsedAt: null });
  const turnId = randomUUID();
  store.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,conversation_id,created_at) VALUES(?,?,?,'m',1,'succeeded',0,?,?)", turnId, draftA.id, "test-provider", conversationId, now);
  store.message(draftA.id, turnId, "user", { text: "ok" }, conversationId);
  // 跨草稿会话引用拒绝。
  assert.throws(() => store.message(draftB.id, null, "user", {}, conversationId), /不属于该草稿/);
  // 消息会话与轮次会话不一致拒绝。
  assert.throws(() => store.message(draftA.id, turnId, "user", {}, null), /不一致/);
  assert.throws(() => store.message(draftA.id, turnId, "user", {}, randomUUID()), /不属于/);
  // 消息与会话过滤。
  assert.equal(store.messages(draftA.id, conversationId).length, 1);
  assert.equal(store.messages(draftA.id, null).length, 0);
  // 自引用重建链：删除草稿时置 NULL 后删除，不触发外键失败。
  const rebuildId = randomUUID();
  store.archiveCurrentConversations(draftA.id);
  store.insertConversation({ id: rebuildId, draftId: draftA.id, mode: "multi", contextMode: "reconstructed", status: "current", providerId: "test-provider", providerRevision: 1, modelId: "test-model", transport: "legacy", connectionFingerprint: "fp", cliVersion: null, backendRef: null, backendGeneration: 0, syncedRevision: null, rebuildFromId: conversationId, createdAt: now, lastUsedAt: null });
  assert.doesNotThrow(() => store.deleteDraft(draftA.id));
  assert.equal(store.one("SELECT id FROM agent_conversations WHERE draft_id=?", draftA.id), undefined);
});

test("recovery interrupts active turns and marks uncertain conversations needs_rebuild", async t => {
  const root = temporary(t), now = Date.now();
  // 每个场景独立草稿（一个草稿最多一个当前对话，部分唯一索引限制）。
  const mk = (store: Store, turnId: string, status: string, submission: string, withConversation: boolean) => {
    const draftId = randomUUID(), conversationId = randomUUID();
    store.exec("INSERT INTO drafts(id,workflow_id,base_version_id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES(?,NULL,NULL,0,'unused','{}','draft',?,?)", draftId, now, now);
    if (withConversation) {
      store.insertConversation({ id: conversationId, draftId, mode: "multi", contextMode: "native", status: "current", providerId: "test-provider", providerRevision: 1, modelId: "m", transport: "native", connectionFingerprint: "fp", cliVersion: null, backendRef: null, backendGeneration: 0, syncedRevision: null, rebuildFromId: null, createdAt: now, lastUsedAt: null });
    }
    store.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,conversation_id,submission_state,created_at) VALUES(?,?,?,'m',1,?,?,?,?,?)", turnId, draftId, "test-provider", status, 0, withConversation ? conversationId : null, submission, now);
    return conversationId;
  };
  const seeding = new Store(root);
  seeding.exec("INSERT INTO provider_settings(id,enabled,config_json,models_json,default_model,revision,updated_at) VALUES('test-provider',1,'{}','[]','',1,0)");
  const uncertain = mk(seeding, "t-sending", "running", "sending", true);
  const settled = mk(seeding, "t-settled", "queued", "settled", true);
  const notSent = mk(seeding, "t-notsent", "cancel_requested", "not_sent", true);
  mk(seeding, "t-legacy", "running", "not_sent", false);
  seeding.close();
  const recovered = new Store(root); t.after(() => recovered.close());
  for (const id of ["t-sending", "t-settled", "t-notsent", "t-legacy"]) {
    assert.equal(recovered.turn(id).status, "interrupted", `${id} should be interrupted`);
  }
  // sending 且未 settled → 会话 needs_rebuild；settled/not_sent 的会话保持 current。
  assert.equal(recovered.conversation(uncertain)!.status, "needs_rebuild");
  assert.equal(recovered.conversation(settled)!.status, "current");
  assert.equal(recovered.conversation(notSent)!.status, "current");
  // 恢复后同草稿可再次提交（活动名额已释放）。
  const draftId = recovered.one<{ draft_id: string }>("SELECT draft_id FROM authoring_turns WHERE id='t-settled'")!.draft_id;
  assert.doesNotThrow(() => recovered.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at) VALUES(?,?,'test-provider','m',1,'queued',0,?)", randomUUID(), draftId, Date.now()));
});
