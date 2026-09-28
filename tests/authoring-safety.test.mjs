import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateWorkflowSource } from "../dist/authoring/compiler.js";
import { AuthoringSessionRepository, createDefaultWorkspace, initializeDatabase } from "../dist/storage/database.js";
import { PiAdapter } from "../dist/integrations/pi/adapter.js";
import { PiAuthoringService } from "../dist/authoring/pi-session.js";

test("workflow source validation rejects unsafe imports and capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchard-source-"));
  try {
    await writeFile(join(root, "worker.ts"), "import fs from 'node:fs'; export default {};\n");
    await assert.rejects(() => validateWorkflowSource({ rootDir: root, entry: "worker.ts" }), /not allowed/);
    await writeFile(join(root, "worker.ts"), "export default { run() { capability('network') } };\n");
    await assert.rejects(() => validateWorkflowSource({ rootDir: root, entry: "worker.ts" }), /capability is not allowed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi authoring persists success and rejects unapproved files", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchard-pi-authoring-")); const db = initializeDatabase(root);
  try {
    const workspaceId = createDefaultWorkspace(db); const draft = db.database.prepare("INSERT INTO workflow_drafts (id, workspace_id, root_path, created_at, updated_at) VALUES ('draft', ?, ?, 1, 1)").run(workspaceId, root);
    assert.equal(draft.changes, 1);
    const sessions = new AuthoringSessionRepository(db); const session = sessions.create({ workspaceId, draftId: "draft" });
    const pi = new PiAdapter({ createSession: async () => ({ run: async () => ({ output: { summary: "ok", patches: [{ path: "worker.ts", content: "export default {};" }] }, provider: "test", model: "test" }) }) });
    const service = new PiAuthoringService(pi, sessions); const result = await service.generate({ sessionId: session.id, workspaceRoot: root, allowedFiles: ["worker.ts"], prompt: "write" }); assert.equal(result.summary, "ok");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
