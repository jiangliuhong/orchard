import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ScriptAgentService } from "../src/authoring/script-agent.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { ScriptJournal } from "../src/persistence/script-journal.js";
import { setupLegacy as setup, until } from "./helpers.js";

const definition = (id = "history-script") => ({
  id, name: "History", description: "", runtime: "nodejs" as const, entryFile: "main.ts",
  inputSchema: true, outputSchema: true, files: { "main.ts": "export default input => input" },
});
const proposal = {
  summary: "完整回复", changes: [{ operation: "update", path: "main.ts", content: "export default input => ({ result: input })" }],
  metadata: { description: "proposal metadata" }, testInput: { text: "example" },
};

test("script Agent replays all persisted requests, complete replies and outcomes across restart with isolation", async context => {
  const { store, providers, provider } = setup(context);
  const library = new ScriptLibrary(store), journal = new ScriptJournal(store.files);
  let agent = new ScriptAgentService(store, providers);
  context.after(async () => { await agent.close(); store.close(); });
  await library.create(definition());
  await library.create(definition("private-script"));
  const conversationId = randomUUID();
  let revision = 0;
  provider.handler = async input => ({ output: proposal, providerId: provider.id, modelId: input.modelId });
  const send = async (prompt: string, conversation = conversationId, scriptId = "history-script") => {
    const turn = agent.start(scriptId, { prompt, conversationId: conversation, expectedRevision: scriptId === "history-script" ? revision : 0, requestId: randomUUID(), providerId: provider.id, modelId: "test-model" });
    await until(() => ["succeeded", "failed", "cancelled", "interrupted"].includes(agent.get(scriptId, turn.id).status));
    return agent.get(scriptId, turn.id);
  };
  await send("other conversation", randomUUID());
  await send("other script", conversationId, "private-script");
  const first = await send("message 0");
  await agent.apply("history-script", { turnId: first.id, expectedRevision: 0, requestId: randomUUID() });
  revision = 1;
  for (let index = 1; index < 10; index++) await send(`message ${index}`);
  provider.handler = async () => { throw new Error("failure detail"); };
  assert.equal((await send("failed request")).status, "failed");
  let waitingForCancellation = false;
  provider.handler = input => {
    input.signal.throwIfAborted();
    return new Promise((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      waitingForCancellation = true;
    });
  };
  const cancelled = agent.start("history-script", { prompt: "cancelled request", conversationId, expectedRevision: revision, requestId: randomUUID(), providerId: provider.id, modelId: "test-model" });
  await until(() => waitingForCancellation);
  agent.cancel("history-script", cancelled.id);
  await until(() => agent.get("history-script", cancelled.id).status === "cancelled");
  // Simulate a persisted in-flight record recovered after process interruption.
  const interruptedId = "f".repeat(64);
  journal.save({ ...journal.read("history-script", cancelled.id)!, id: interruptedId, prompt: "interrupted request", status: "running", error: undefined, createdAt: Date.now() + 1 });
  await agent.close();
  agent = new ScriptAgentService(store, providers);
  assert.equal(agent.get("history-script", interruptedId).status, "interrupted");
  provider.handler = async input => ({ output: { summary: "继续", changes: [], metadata: {} }, providerId: provider.id, modelId: input.modelId });
  assert.equal((await send("continue")).status, "succeeded");
  const data = JSON.parse(provider.calls.at(-1)!.prompt.split("\nContext (data):\n")[1]!);
  assert.equal(data.history.length, 13);
  assert.deepEqual(data.history.slice(0, 10).map((item: { user: string }) => item.user), Array.from({ length: 10 }, (_, index) => `message ${index}`));
  for (const entry of data.history.slice(0, 10)) assert.deepEqual(entry.assistant, proposal);
  assert.equal(data.history[0].applied, true);
  assert.equal(data.history[0].appliedRevision, 1);
  assert.equal(data.history[1].applied, false);
  assert.equal(data.history[1].appliedRevision, null);
  assert.deepEqual(data.history.slice(10).map((item: { status: string }) => item.status), ["failed", "cancelled", "interrupted"]);
  for (const entry of data.history.slice(10)) {
    assert.ok(entry.error);
    assert.equal(entry.assistant, undefined);
  }
  assert.deepEqual(data.script.files, { "main.ts": proposal.changes[0]!.content });
  assert.equal(data.history.some((entry: { user: string }) => entry.user.startsWith("other")), false);
});

test("script Agent rejects oversized full history without silently dropping turns or calling the Provider", async context => {
  const { store, providers, provider } = setup(context);
  const library = new ScriptLibrary(store), agent = new ScriptAgentService(store, providers);
  context.after(async () => { await agent.close(); store.close(); });
  await library.create(definition());
  provider.handler = async input => ({ output: proposal, providerId: provider.id, modelId: input.modelId });
  const input = { prompt: "first", expectedRevision: 0, requestId: randomUUID(), providerId: provider.id, modelId: "test-model" };
  const first = agent.start("history-script", input);
  await until(() => agent.get("history-script", first.id).status === "succeeded");
  const journal = new ScriptJournal(store.files), record = journal.read("history-script", first.id)!;
  journal.save({ ...record, proposal: { ...proposal, changes: [{ operation: "update", path: "main.ts", content: `export default () => null;\n//${"x".repeat(520 * 1024)}` }] } });
  const calls = provider.calls.length;
  const next = agent.start("history-script", { ...input, prompt: "continue", requestId: randomUUID() });
  await until(() => agent.get("history-script", next.id).status === "failed");
  assert.equal(agent.get("history-script", next.id).error?.code, "CONTEXT_LIMIT");
  assert.equal(provider.calls.length, calls);
  assert.deepEqual(library.detail("history-script").draft!.files, definition().files);
});
