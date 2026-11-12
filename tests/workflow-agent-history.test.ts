import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setupLegacy as setup } from "./helpers.js";

const envelope = (prompt: string) => JSON.parse(prompt.split(/Authoring context \(untrusted data, contextVersion 1\):\n/)[1]!.split("\nLatest user request:")[0]!);

test("workflow rebuild replays complete saved proposals and messages through successive rebuilds", async context => {
  const { store, authoring, provider } = setup(context);
  context.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const proposal = { summary: "完整源码回复", changes: [{ operation: "update", path: "scripts/start.ts", content: "export default async input => input;\n//" + "长".repeat(4000) }] };
  provider.handler = async request => ({ output: proposal, providerId: provider.id, modelId: request.modelId });
  const first = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "original request", expectedRevision: 0, requestId: randomUUID() });
  await authoring.wait(first.id);
  assert.equal(store.turn(first.id).status, "succeeded");
  const source = store.currentConversation(draft.id)!;
  const savedAssistant = store.messages(draft.id, source.id).find(message => message.role === "assistant")!;
  assert.deepEqual((savedAssistant.content as { proposal: unknown }).proposal, proposal);
  // More than the former 20-message limit, and an error without a text wrapper.
  for (let index = 0; index < 30; index++) store.message(draft.id, null, "user", { text: `history ${index}` }, source.id);
  store.message(draft.id, null, "error", { code: "FAILED", message: "saved failure" }, source.id);
  const unrelated = await authoring.conversations.create(draft.id, { providerId: provider.id, modelId: "test-model", mode: "multi", expectedRevision: 1, requestId: randomUUID() });
  store.message(draft.id, null, "user", { text: "PRIVATE_UNRELATED_CONVERSATION" }, unrelated.id);
  provider.handler = async request => ({ output: { summary: "continued", changes: [] }, providerId: provider.id, modelId: request.modelId });
  await authoring.conversations.resume(draft.id, source.id, { expectedRevision: 1, requestId: randomUUID() });
  let sourceId = source.id;
  for (let index = 0; index < 2; index++) {
    store.markConversation(sourceId, "needs_rebuild");
    const rebuilt = await authoring.conversations.rebuild(draft.id, sourceId, { providerId: provider.id, modelId: "test-model", mode: "multi", expectedRevision: 1, requestId: randomUUID() });
    const expected = index === 0 ? store.messages(draft.id, source.id) : [
      ...store.messages(draft.id, source.id), ...store.messages(draft.id, sourceId),
    ];
    const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: `rebuild ${index}`, expectedRevision: 1, conversationId: rebuilt.id, requestId: randomUUID() });
    await authoring.wait(turn.id);
    assert.equal(store.turn(turn.id).status, "succeeded");
    const prompt = provider.calls.at(-1)!.prompt, data = envelope(prompt);
    assert.deepEqual(data.historyExcerpt.messages, expected.map(({ role, content }) => ({ role, content })));
    assert.equal(data.historyExcerpt.truncated, false);
    assert.ok(!prompt.includes("PRIVATE_UNRELATED_CONVERSATION"));
    assert.deepEqual(data.files, authoring.snapshot(draft.id).files);
    sourceId = rebuilt.id;
  }
  // A normal continuation uses the native session instead of replaying history again.
  const continued = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "native continuation", expectedRevision: 1, conversationId: sourceId, requestId: randomUUID() });
  await authoring.wait(continued.id);
  assert.equal(envelope(provider.calls.at(-1)!.prompt).historyExcerpt, undefined);
});

test("workflow rebuild rejects oversized complete history before sending a turn", async context => {
  const { store, authoring, provider } = setup(context);
  context.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const source = await authoring.conversations.create(draft.id, { providerId: provider.id, modelId: "test-model", mode: "multi", expectedRevision: 0, requestId: randomUUID() });
  store.message(draft.id, null, "user", { text: "x".repeat(512 * 1024) }, source.id);
  store.markConversation(source.id, "needs_rebuild");
  const rebuilt = await authoring.conversations.rebuild(draft.id, source.id, { providerId: provider.id, modelId: "test-model", expectedRevision: 0, requestId: randomUUID() });
  const calls = provider.calls.length, messages = store.messages(draft.id).length;
  await assert.rejects(authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "continue", expectedRevision: 0, conversationId: rebuilt.id, requestId: randomUUID() }), { code: "CONTEXT_LIMIT" });
  assert.equal(provider.calls.length, calls);
  assert.equal(store.messages(draft.id).length, messages);
  assert.equal(store.conversation(rebuilt.id)!.backendRef, null);
});
