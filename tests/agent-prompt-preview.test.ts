import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/app.js";
import { setup } from "./helpers.js";
import { AUTHORING_PROMPT_RULES } from "../src/authoring/context.js";
import { SCRIPT_AGENT_PROMPT, bridgeAgentSystemPrompt } from "../src/authoring/default-prompts.js";

test("default Agent prompt preview exposes shared rules and schemas without business context", async context => {
  const { store, providers } = setup(context);
  const { app, bridge } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  bridge.saveApplication({ id: "private", name: "PRIVATE_CONTEXT_MARKER" });
  const response = await app.inject({ url: "/api/settings/agent-prompts" });
  assert.equal(response.statusCode, 200);
  const { items } = response.json();
  assert.deepEqual(items.map((item: { id: string }) => item.id), ["workflow", "web-bridge", "script"]);
  assert.equal(items[0].prompt, AUTHORING_PROMPT_RULES.join("\n"));
  assert.equal(items[1].prompt, bridgeAgentSystemPrompt("example-app"));
  assert.equal(items[2].prompt, SCRIPT_AGENT_PROMPT);
  for (const item of items) { assert.equal(item.schema.type, "object"); assert.ok(item.contextNote); }
  assert.ok(!response.body.includes("PRIVATE_CONTEXT_MARKER"));
  assert.equal((await app.inject({ url: "/api/settings/agent-prompts", headers: { origin: "https://evil.test" } })).statusCode, 403);
});
