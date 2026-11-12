import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SCRIPT_AGENT_PROMPT, SCRIPT_AGENT_EXAMPLES } from "../src/authoring/script-agent-prompt.js";
import { SCRIPT_PROPOSAL_SCHEMA, prepareScriptProposal } from "../src/domain/script-authoring.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";
import { assertSchema } from "../src/domain/validation.js";
import { canonicalJson } from "../src/persistence/files.js";
import { executeScript } from "../src/runtime/script.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { ScriptAgentService } from "../src/authoring/script-agent.js";
import { setupLegacy as setup, until } from "./helpers.js";

const draft = (runtime: "nodejs" | "shell"): ScriptDefinition => ({
  id: "prompt-example", name: "Example", description: "", runtime,
  entryFile: runtime === "nodejs" ? "main.ts" : "main.sh",
  inputSchema: true, outputSchema: true,
  files: runtime === "nodejs" ? { "main.ts": "export default input => input" } : { "main.sh": "cat" },
});

test("script prompt embeds the authoritative proposal schema and complete examples", () => {
  assert.ok(SCRIPT_AGENT_PROMPT.includes(canonicalJson(SCRIPT_PROPOSAL_SCHEMA)));
  for (const proposal of Object.values(SCRIPT_AGENT_EXAMPLES)) {
    assertSchema(proposal, SCRIPT_PROPOSAL_SCHEMA);
    assert.ok(SCRIPT_AGENT_PROMPT.includes(canonicalJson(proposal)));
  }
  assert.deepEqual(prepareScriptProposal(draft("nodejs"), SCRIPT_AGENT_EXAMPLES.clarification).definition, draft("nodejs"));
  for (const change of [
    { action: "update", path: "main.ts", content: "export default () => null" },
    { operation: "update", path: "main.ts", content: "export default () => null", extra: true },
  ]) assert.throws(() => prepareScriptProposal(draft("nodejs"), { summary: "bad", changes: [change], metadata: {} }), { code: "SCHEMA_MISMATCH" });
});

for (const name of ["nodejs", "shellJson", "shellProcess"] as const) {
  test(`script prompt ${name} example prepares, compiles and executes under the actual runtime`, async context => {
    const { store } = setup(context);
    context.after(() => store.close());
    const proposal = SCRIPT_AGENT_EXAMPLES[name];
    const { definition } = prepareScriptProposal(draft(name === "nodejs" ? "nodejs" : "shell"), proposal);
    assertSchema(proposal.testInput, definition.inputSchema);
    const result = await executeScript({ ...definition, input: proposal.testInput, cwd: store.files.path("runs"), timeoutMs: 5000 });
    assertSchema(result.output, definition.outputSchema);
    if (name === "nodejs") assert.deepEqual(result.output, { text: "HELLO" });
    else if (name === "shellJson") {
      assert.deepEqual(result.output, proposal.testInput);
      assert.equal(result.stdout, "done\n");
    } else assert.deepEqual(result.output, { stdout: JSON.stringify(proposal.testInput), stderr: "", exitCode: 0 });
  });
}

test("script Agent sends shared guidance, schema and authoritative draft before separate context data", async context => {
  const { store, providers, provider } = setup(context);
  const library = new ScriptLibrary(store), agent = new ScriptAgentService(store, providers);
  context.after(async () => { await agent.close(); store.close(); });
  const definition = draft("nodejs");
  await library.create(definition);
  let captured = false;
  provider.handler = async request => {
    captured = true;
    assert.deepEqual(request.schema, SCRIPT_PROPOSAL_SCHEMA);
    assert.ok(request.prompt.startsWith(`${SCRIPT_AGENT_PROMPT}\nContext (data):\n`));
    const data = JSON.parse(request.prompt.slice(`${SCRIPT_AGENT_PROMPT}\nContext (data):\n`.length));
    assert.deepEqual(data.script, store.scriptDefinition(definition.id, store.script(definition.id).currentDraftVersionId!));
    assert.equal(data.request, "将文本转成大写");
    assert.ok(Array.isArray(data.availableDictionaries));
    return { output: SCRIPT_AGENT_EXAMPLES.nodejs, providerId: provider.id, modelId: request.modelId };
  };
  const turn = agent.start(definition.id, { prompt: "将文本转成大写", expectedRevision: 0, requestId: randomUUID(), providerId: provider.id, modelId: "test-model" });
  await until(() => ["succeeded", "failed"].includes(agent.get(definition.id, turn.id).status));
  assert.equal(captured, true);
  assert.equal(agent.get(definition.id, turn.id).status, "succeeded", JSON.stringify(agent.get(definition.id, turn.id).error));
  assert.deepEqual(library.detail(definition.id).draft!.files, definition.files);
});
