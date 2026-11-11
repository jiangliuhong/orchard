import assert from "node:assert/strict";
import { test } from "node:test";
import { agentKnowledgeSettings } from "../src/agent/settings.js";
import { loadKnowledgeBundle } from "../src/agent/knowledge-bundle.js";
import { createApp } from "../src/server/app.js";
import { setup } from "./helpers.js";

test("knowledge settings exposes validated package files without claiming production activation", () => {
  const view = agentKnowledgeSettings(), bundle = loadKnowledgeBundle();
  assert.equal(view.hash, bundle.hash); assert.equal(view.runtime.active, false);
  assert.ok(view.files.some(file => file.path === ".agents/mcp.json"));
  assert.ok(view.files.some(file => file.path === ".agents/skills/workflow-authoring/SKILL.md"));
  for (const file of view.files) assert.equal(file.content, file.path === "manifest.json" ? bundle.manifestText : bundle.files[file.path]);
});

test("knowledge HTTP settings is read-only and retains local host/origin protection", async t => {
  const { store, providers, authoring } = setup(t);
  const { app } = createApp(store, providers);
  t.after(async () => { await authoring.close(); await app.close(); });
  const response = await app.inject({ method: "GET", url: "/api/settings/agent-knowledge" });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().hash, loadKnowledgeBundle().hash);
  for (const method of ["PUT", "POST", "DELETE"] as const) {
    assert.equal((await app.inject({ method, url: "/api/settings/agent-knowledge", payload: {} })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/settings/agent-knowledge", headers: { host: "remote.example" } })).statusCode, 403);
});
