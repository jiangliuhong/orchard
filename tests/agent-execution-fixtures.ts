import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { AGENT_RUNTIME_SCHEMA } from "../src/agent/schema.js";
import { AgentStore } from "../src/agent/store.js";
import { ConversationLocks } from "../src/agent/locks.js";
import { digest } from "../src/persistence/files.js";

export function executionFixture(t: TestContext, mode: "single" | "multi" = "multi") {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE provider_settings(id TEXT PRIMARY KEY); INSERT INTO provider_settings VALUES('third-provider');
    CREATE TABLE command_receipts(scope TEXT,request_id TEXT,request_hash TEXT,result_json TEXT,created_at INTEGER,PRIMARY KEY(scope,request_id));`);
  db.exec(AGENT_RUNTIME_SCHEMA);
  const hash = digest("knowledge");
  db.prepare("INSERT INTO agent_workspaces VALUES('maintenance','agent/workspace',?,'ready',1,1)").run(hash);
  const store = new AgentStore(db), locks = new ConversationLocks(), actor = "local";
  const conversation = store.create(actor, "create", {
    scenario: "workflow", ownerType: "draft", ownerId: "draft-id", ownerScope: {}, mode, providerId: "third-provider", modelId: "model",
    knowledgeHash: mode === "multi" ? hash : undefined, workspaceId: mode === "multi" ? "maintenance" : undefined,
    contractVersion: "unified-agent-v1", toolPolicyVersion: "platform-read-v1",
  }).conversation;
  const reference = { providerId: "third-provider", version: 1, opaque: "native-identity" };
  const validator = { providerId: "third-provider", supportedVersions: [1], validatePayload() {} };
  const bind = () => store.saveBackend(actor, conversation.id, { expectedRevision: store.conversation(actor, conversation.id).revision, expectedGeneration: 0, generation: 1, reference, fingerprint: digest("fingerprint"), validator });
  const start = () => {
    const { turn } = store.submit(actor, conversation.id, { requestId: "turn", requestHash: digest("turn") });
    if (mode === "multi") bind();
    store.markSending(actor, turn.id, 1); store.markAccepted(actor, turn.id, 1);
    return store.turn(actor, turn.id);
  };
  return { db, store, locks, actor, conversation, bind, start, reference };
}
