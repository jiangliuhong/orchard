import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync, backup } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { previewAgentReset } from "../src/agent/reset-preview.js";
import { temporary } from "./helpers.js";
import { SCHEMA } from "../src/persistence/schema.js";
import { AGENT_RUNTIME_SCHEMA } from "../src/agent/schema.js";
import { previewLegacyAgentReset, applyLegacyAgentDatabaseReset } from "../src/agent/legacy-reset.js";
import { AgentStore } from "../src/agent/store.js";

function legacy(t: TestContext) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON;"); db.exec(SCHEMA);
  db.exec(`
    INSERT INTO provider_settings VALUES('provider',1,'{}','[]','model',1,1);
    INSERT INTO workflows VALUES('wf','business workflow',NULL,1,1);
    INSERT INTO workflow_versions VALUES('version','wf',1,'{}','{}','business/tree','hash',1);
    UPDATE workflows SET current_version_id='version';
    INSERT INTO drafts VALUES('draft','wf','version',1,'business/draft','{}',NULL,'draft',1,1);
    INSERT INTO agent_conversations(id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,transport,connection_fingerprint,backend_generation,created_at,updated_at)
      VALUES('old-conv','draft','multi','native','idle','provider',1,'model','native','fingerprint',1,1,1);
    INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at,ended_at,conversation_id,submission_state)
      VALUES('old-turn','draft','provider','model',1,'succeeded',1,1,2,'old-conv','settled');
    INSERT INTO authoring_messages VALUES('old-message','draft','old-turn',1,'assistant','{"proposal":"old chat body"}',1,'old-conv');
    INSERT INTO stream_events VALUES('authoring_turn','old-turn',1,'turn.completed',NULL,NULL,'old-agent-payload',1);
    INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES('run','version','succeeded','business-input',1);
    INSERT INTO stream_events VALUES('run','run',1,'run.completed',NULL,NULL,'business-event-payload',1);
    INSERT INTO scripts(id,name,runtime,status,created_at,updated_at) VALUES('script','business script','nodejs','published',1,1);
    INSERT INTO script_versions(id,script_id,version_no,status,revision,entry_file,input_schema_json,output_schema_json,source_ref,content_hash,validation_json,created_at,updated_at)
      VALUES('sv','script',1,'published',1,'main.ts','{}','{}','business-script-source','hash','{}',1,1);
    INSERT INTO script_tests(id,script_id,script_version_id,status,input_ref,created_at) VALUES('st','script','sv','succeeded','business-test-input',1);
    INSERT INTO command_receipts VALUES('turn:draft','r1','hash','{"turnId":"old-turn"}',1);
    INSERT INTO command_receipts VALUES('conversation:draft','r2','hash','{"conversationId":"old-conv"}',1);
    INSERT INTO command_receipts VALUES('script-agent-confirm:script','r3','hash','{"revision":2}',1);
    INSERT INTO command_receipts VALUES('script-agent-apply:script','r4','hash','{"revision":2}',1);
    INSERT INTO command_receipts VALUES('publish:draft','keep','hash','{"versionId":"version"}',1);
    INSERT INTO command_receipts VALUES('draft','keep','hash','{"draftId":"draft"}',1);
    INSERT INTO artifacts VALUES('business-artifact','business/file','hash',10,'application/json',1);
  `);
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return { db, count };
}

test("reset preview is read-only and enumerates exact Agent rows/scopes", t => {
  const { db, count } = legacy(t), preview = previewLegacyAgentReset(db);
  assert.equal(preview.sourceVersion, 10); assert.equal(preview.targetVersion, 11);
  assert.equal(preview.conversations, 1); assert.equal(preview.turns, 1); assert.equal(preview.messages, 1); assert.equal(preview.authoringEvents, 1);
  assert.deepEqual(preview.receiptScopes, ["conversation:draft", "script-agent-apply:script", "script-agent-confirm:script", "turn:draft"]);
  assert.equal(preview.filesystemResetRequired, true);
  assert.equal(count("authoring_messages"), 1);
  assert.equal(JSON.stringify(preview).includes("old chat body"), false);
  assert.equal(JSON.stringify(preview).includes("business-input"), false);
  assert.deepEqual(previewLegacyAgentReset(db), preview);
});

test("reset preview CLI reads an explicitly selected fixture without changing its schema or rows", async t => {
  const { db } = legacy(t), root = realpathSync(temporary(t));
  const file = join(root, "workbench.db");
  await backup(db, file);
  mkdirSync(join(root, "agent-workspaces"));
  const oldFile = join(root, "agent-workspaces", "old");
  writeFileSync(oldFile, "legacy workspace");
  mkdirSync(join(root, "artifacts"));
  writeFileSync(join(root, "artifacts", "business"), "business artifact");
  const cli = ["--import", "tsx", "src/cli/index.ts", "agent-reset", "preview"];
  assert.throws(() => execFileSync(process.execPath, cli, { stdio: "pipe" }), /DATA_DIR_REQUIRED/);
  const output = execFileSync(process.execPath, [...cli, "--data-dir", root], { encoding: "utf8" });
  const preview = JSON.parse(output) as ReturnType<typeof previewAgentReset>;
  assert.deepEqual(preview.database, previewLegacyAgentReset(db));
  assert.deepEqual(preview.filesystem.files.map(entry => entry.path), ["agent-workspaces", "agent-workspaces/old"]);
  assert.deepEqual(preview.filesystem.missing, ["agent-sessions/pi", "script-agent"]);
  assert.equal(preview.confirmationToken, previewAgentReset(root).confirmationToken);
  writeFileSync(oldFile, "edited legacy workspace");
  assert.notEqual(preview.confirmationToken, previewAgentReset(root).confirmationToken);
  const original = new DatabaseSync(file, { readOnly: true });
  try { assert.deepEqual(previewLegacyAgentReset(original), previewLegacyAgentReset(db)); }
  finally { original.close(); }
});

test("approved DB reset is transactional, replaces only Agent tables and preserves business records", t => {
  const { db, count } = legacy(t), preview = previewLegacyAgentReset(db);
  let proofChecks = 0;
  applyLegacyAgentDatabaseReset(db, preview, { confirmationToken: preview.confirmationToken, assertQuiesced() { proofChecks++; } });
  assert.equal(proofChecks, 1);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 11);
  assert.equal(count("agent_conversations"), 0); assert.equal(count("agent_turns"), 0);
  assert.throws(() => count("authoring_turns"), /no such table/);
  assert.throws(() => count("authoring_messages"), /no such table/);
  for (const table of ["workflows", "workflow_versions", "drafts", "runs", "scripts", "script_versions", "script_tests", "artifacts"]) assert.equal(count(table), 1, table);
  assert.equal(count("stream_events"), 1);
  assert.equal(db.prepare("SELECT stream_type FROM stream_events").get()!.stream_type, "run");
  assert.equal(count("command_receipts"), 2);
  assert.equal(db.prepare("SELECT result_json FROM command_receipts WHERE scope='publish:draft'").get()!.result_json, '{"versionId":"version"}');
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const store = new AgentStore(db);
  const conversation = store.create("local", "create", { scenario: "node", ownerType: "run", ownerId: "run", ownerScope: {}, mode: "single", providerId: "provider", modelId: "model", contractVersion: "1", toolPolicyVersion: "none" }).conversation;
  assert.equal(conversation.mode, "single");
  assert.throws(() => previewLegacyAgentReset(db), { code: "AGENT_RESET_VERSION_UNSUPPORTED" });
});

test("schema approval alone is not destructive confirmation; quiescence proof is mandatory", t => {
  const { db, count } = legacy(t), preview = previewLegacyAgentReset(db);
  assert.throws(() => applyLegacyAgentDatabaseReset(db, preview, { confirmationToken: "not-confirmed", assertQuiesced() { assert.fail("must not run"); } }), { code: "AGENT_RESET_CONFIRMATION_REQUIRED" });
  assert.throws(() => applyLegacyAgentDatabaseReset(db, preview, { confirmationToken: preview.confirmationToken, assertQuiesced() { throw new Error("old process still active"); } }), /still active/);
  assert.throws(() => applyLegacyAgentDatabaseReset(db, preview, { confirmationToken: preview.confirmationToken, assertQuiesced: (() => Promise.resolve()) as unknown as () => void }), { code: "AGENT_RESET_PROCESS_UNCONFIRMED" });
  assert.equal(count("authoring_messages"), 1); assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 10);
});

test("any data change invalidates destructive preview, even if row counts are unchanged", t => {
  const { db, count } = legacy(t), preview = previewLegacyAgentReset(db);
  db.prepare("UPDATE workflows SET name='new business name' WHERE id='wf'").run();
  assert.throws(() => applyLegacyAgentDatabaseReset(db, preview, { confirmationToken: preview.confirmationToken, assertQuiesced() {} }), { code: "AGENT_RESET_PREVIEW_STALE" });
  assert.equal(count("authoring_messages"), 1);
  assert.equal(db.prepare("SELECT name FROM workflows").get()!.name, "new business name");
});

test("active/uncertain old tasks block reset preview", t => {
  const { db } = legacy(t);
  db.prepare("UPDATE authoring_turns SET status='running'").run();
  assert.throws(() => previewLegacyAgentReset(db), { code: "AGENT_RESET_TURN_ACTIVE" });
  db.prepare("UPDATE authoring_turns SET status='interrupted',submission_state='accepted'").run();
  assert.throws(() => previewLegacyAgentReset(db), { code: "AGENT_RESET_TURN_ACTIVE" });
});

test("unknown business FKs and views referencing old turns require new review", t => {
  const { db } = legacy(t);
  db.exec("CREATE TABLE business_trace(id TEXT PRIMARY KEY,turn_id TEXT REFERENCES authoring_turns(id));");
  assert.throws(() => previewLegacyAgentReset(db), { code: "AGENT_RESET_UNREVIEWED_DEPENDENCY" });
  db.exec("DROP TABLE business_trace; CREATE VIEW user_agent_view AS SELECT id FROM agent_conversations;");
  assert.throws(() => previewLegacyAgentReset(db), { code: "AGENT_RESET_UNREVIEWED_DEPENDENCY" });
});

test("sqlite-prefixed business table names are not mistaken for reserved sqlite_ internal tables", t => {
  const { db } = legacy(t);
  db.exec("CREATE TABLE sqliteBusinessTrace(id TEXT PRIMARY KEY,turn_id TEXT REFERENCES authoring_turns(id) ON DELETE CASCADE);");
  assert.throws(() => previewLegacyAgentReset(db), { code: "AGENT_RESET_UNREVIEWED_DEPENDENCY" });
});

test("unattributable Agent receipts are not deleted using a wildcard", t => {
  const { db, count } = legacy(t);
  db.exec("INSERT INTO command_receipts VALUES('turn:unknown-owner','r','hash','{}',1);");
  assert.throws(() => previewLegacyAgentReset(db), { code: "AGENT_RESET_UNREVIEWED_RECEIPT" });
  assert.equal(count("command_receipts"), 7);
});

test("fault after DDL rolls back schema, history and version in the same transaction", t => {
  const { db, count } = legacy(t), preview = previewLegacyAgentReset(db), original = db.exec;
  db.exec = function (sql: string) { original.call(this, sql); if (sql === AGENT_RUNTIME_SCHEMA) throw new Error("injected after schema creation"); };
  assert.throws(() => applyLegacyAgentDatabaseReset(db, preview, { confirmationToken: preview.confirmationToken, assertQuiesced() {} }), /injected/);
  db.exec = original;
  assert.equal(count("authoring_messages"), 1); assert.equal(count("authoring_turns"), 1); assert.equal(count("agent_conversations"), 1);
  assert.throws(() => count("agent_turns"), /no such table/);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 10);
  assert.deepEqual(previewLegacyAgentReset(db), preview);
});
