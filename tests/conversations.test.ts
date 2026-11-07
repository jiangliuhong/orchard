import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, until } from "./helpers.js";
import { createApp } from "../src/server/app.js";
import { titleFromPrompt } from "../src/authoring/conversations.js";
import type { ConversationRecord } from "../src/persistence/store.js";

const command = (expectedRevision = 0) => ({ expectedRevision, requestId: randomUUID() });

test("create rotates current to idle, rebuild keeps diagnostics, and commands are idempotent", async t => {
  const { store, providers, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const conversations = authoring.conversations;
  const first = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", mode: "multi", ...command() });
  assert.equal(first.status, "current");
  assert.equal(first.title, null);
  await assert.rejects(
    conversations.rebuild(draft.id, first.id, { providerId: "test-provider", modelId: "test-model", mode: "multi", ...command() }),
    /仅可重建需要重建的对话/,
  );
  // 新对话：旧 current 转 idle 历史，needs_rebuild 诊断不受影响。
  store.markConversation(first.id, "needs_rebuild");
  const rebuilt = await conversations.rebuild(draft.id, first.id, { providerId: "test-provider", modelId: "test-model", mode: "multi", ...command() });
  assert.equal(rebuilt.status, "current");
  assert.equal(rebuilt.rebuildFromId, first.id);
  assert.equal(store.conversation(first.id)!.status, "needs_rebuild");
  const second = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", mode: "multi", ...command() });
  assert.equal(store.conversation(rebuilt.id)!.status, "idle");
  assert.equal(store.conversation(first.id)!.status, "needs_rebuild");
  assert.equal(second.status, "current");
  // 幂等：同 requestId 返回首次结果；不同请求体冲突。
  const replayBody = { providerId: "test-provider", modelId: "test-model", mode: "multi" as const, expectedRevision: 0, requestId: "replay" };
  const replay = await conversations.create(draft.id, replayBody);
  assert.equal((await conversations.create(draft.id, replayBody)).id, replay.id);
  await assert.rejects(conversations.create(draft.id, { ...replayBody, mode: "single" as const }), /不同内容/);
});

test("resume, archive, restore and rename follow the state machine with 404 and revision guards", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const other = await authoring.create(undefined, randomUUID());
  const conversations = authoring.conversations;
  const first = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() });
  const second = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() });
  await assert.rejects(
    conversations.rebuild(draft.id, first.id, { providerId: "test-provider", modelId: "test-model", ...command() }),
    /仅可重建需要重建的对话/,
  );
  // 跨草稿引用统一 404，不泄露其他草稿；current 不能直接 resume。
  await assert.rejects(conversations.resume(draft.id, second.id, command()), /仅可继续/);
  await assert.rejects(conversations.resume(other.id, first.id, command()), /不属于该草稿/);
  await assert.rejects(conversations.archive(draft.id, "missing", command()), /不属于该草稿/);
  // 继续：second 转 idle 后可继续，first 回到 current。
  const resumed = await conversations.resume(draft.id, first.id, command());
  assert.equal(resumed.status, "current");
  assert.equal(store.conversation(second.id)!.status, "idle");
  // 修订冲突。
  await assert.rejects(conversations.archive(draft.id, first.id, { expectedRevision: 9, requestId: randomUUID() }), /草稿已更新/);
  // 归档 current → 无 current；恢复后回 current 且可继续归档 idle。
  const archived = await conversations.archive(draft.id, first.id, command());
  assert.equal(archived.status, "archived");
  assert.ok(archived.archivedAt !== null);
  assert.equal(store.currentConversation(draft.id), undefined);
  // idle 对话也可归档。
  await conversations.archive(draft.id, second.id, command());
  const restored = await conversations.restore(draft.id, first.id, command());
  assert.equal(restored.status, "current");
  assert.equal(restored.archivedAt, archived.archivedAt);
  // 改名：不影响状态与消息；空标题拒绝。
  const renamed = await conversations.rename(draft.id, first.id, { title: "调试记录", ...command() });
  assert.equal(renamed.title, "调试记录");
  assert.equal(renamed.status, "current");
  await assert.rejects(conversations.rename(draft.id, first.id, { title: "  ", ...command() }), /标题长度/);
});

test("active turns block every conversation management command", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const conversations = authoring.conversations;
  const first = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() });
  await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() });
  store.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at) VALUES(?,?,?,'m',1,'running',0,?)", randomUUID(), draft.id, "test-provider", Date.now());
  for (const attempt of [
    conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() }),
    conversations.resume(draft.id, first.id, command()),
    conversations.archive(draft.id, first.id, command()),
    conversations.restore(draft.id, first.id, command()),
    conversations.rename(draft.id, first.id, { title: "x", ...command() }),
    conversations.rebuild(draft.id, first.id, { providerId: "test-provider", modelId: "test-model", ...command() }),
  ]) await assert.rejects(attempt, /活动轮次/);
  store.exec("UPDATE authoring_turns SET status='succeeded',ended_at=? WHERE draft_id=?", Date.now(), draft.id);
  assert.equal((await conversations.resume(draft.id, first.id, command())).status, "current");
});

test("ensureForTurn lazily creates on empty drafts, forces rebuild after needs_rebuild and rejects idle or archived targets", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const conversations = authoring.conversations;
  const selection = { providerId: "test-provider", modelId: "test-model", mode: "multi" as const };
  // 空草稿首轮懒创建（旧客户端兼容）。
  const lazy = conversations.ensureForTurn(draft.id, selection);
  assert.equal(lazy.status, "current");
  // 显式 idle / archived 提交拒绝；needs_rebuild 拒绝并要求重建。
  store.demoteCurrentConversation(draft.id);
  assert.throws(() => conversations.ensureForTurn(draft.id, { ...selection, conversationId: lazy.id }), /只能向当前会话提交/);
  const created = await conversations.create(draft.id, { ...selection, ...command() });
  store.markConversation(created.id, "needs_rebuild");
  const historyTime = Date.now() + 1000;
  store.exec("UPDATE agent_conversations SET created_at=? WHERE id=?", historyTime, created.id);
  assert.throws(() => conversations.ensureForTurn(draft.id, { ...selection, conversationId: created.id }), /SESSION_REBUILD_REQUIRED|重建上下文/);
  // 无 current 且存在 needs_rebuild：隐式提交同样要求显式重建。
  assert.throws(() => conversations.ensureForTurn(draft.id, selection), /SESSION_REBUILD_REQUIRED|重建上下文/);
  const rebuilt = await conversations.rebuild(draft.id, created.id, { ...selection, ...command() });
  // 重建后新的 current 恢复隐式提交；归档 current 后隐式提交要求显式选择。
  assert.equal(conversations.ensureForTurn(draft.id, selection).id, rebuilt.id);
  await conversations.archive(draft.id, rebuilt.id, command());
  store.exec("UPDATE agent_conversations SET created_at=? WHERE id=?", historyTime + 1, rebuilt.id);
  assert.throws(() => conversations.ensureForTurn(draft.id, selection), /请新建或继续一个对话/);
});

test("native rebuilding includes source history only on the first turn and single calls stay isolated", async t => {
  const { store, provider, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  provider.handler = async request => ({ output: { summary: "上下文暗号", changes: [] }, providerId: provider.id, modelId: request.modelId });
  const first = await authoring.start(draft.id, { providerId: provider.id, prompt: "请记住暗号", expectedRevision: 0, requestId: randomUUID() });
  await authoring.wait(first.id);
  const source = store.currentConversation(draft.id)!;
  store.markConversation(source.id, "needs_rebuild");
  const rebuilt = await authoring.conversations.rebuild(draft.id, source.id, {
    providerId: provider.id, modelId: "test-model", ...command(),
  });
  const start = () => authoring.start(draft.id, {
    providerId: provider.id, prompt: "继续", expectedRevision: 0, requestId: randomUUID(), conversationId: rebuilt.id,
  });
  const second = await start();
  await authoring.wait(second.id);
  assert.equal(store.turn(second.id).status, "succeeded");
  assert.match(provider.calls.at(-1)!.prompt, /explicit_rebuild/);
  assert.match(provider.calls.at(-1)!.prompt, /请记住暗号/);
  const third = await start();
  await authoring.wait(third.id);
  assert.doesNotMatch(provider.calls.at(-1)!.prompt, /historyExcerpt/);
  await authoring.conversations.create(draft.id, { providerId: provider.id, modelId: "test-model", mode: "single", ...command() });
  for (let index = 0; index < 2; index++) {
    const turn = await authoring.start(draft.id, { providerId: provider.id, prompt: "单次", mode: "single", expectedRevision: 0, requestId: randomUUID() });
    await authoring.wait(turn.id);
    assert.equal(store.turn(turn.id).status, "succeeded");
    assert.doesNotMatch(provider.calls.at(-1)!.prompt, /historyExcerpt/);
  }
});

test("first user message backfills a deterministic title and manual renames survive later turns", async t => {
  const { store, provider, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  provider.handler = async request => ({ output: { summary: "done", changes: [] }, providerId: provider.id, modelId: request.modelId });
  const long = `${"这是一段很长的首条需求描述，".repeat(20)}`;
  const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: long, expectedRevision: 0, requestId: randomUUID() });
  await authoring.wait(turn.id);
  const record = store.currentConversation(draft.id)!;
  assert.equal(record.title, titleFromPrompt(long));
  assert.ok(record.title!.endsWith("…"));
  // 手动改名后，下一轮不再覆盖。
  await authoring.conversations.rename(draft.id, record.id, { title: "手动命名", ...command() });
  const second = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "第二条", expectedRevision: 0, requestId: randomUUID() });
  await authoring.wait(second.id);
  assert.equal(store.currentConversation(draft.id)!.title, "手动命名");
});

test("list orders by recent activity and exposes derived fields per conversation", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const conversations = authoring.conversations;
  const first = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() });
  const second = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() });
  const turnId = randomUUID();
  store.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,conversation_id,created_at) VALUES(?,?,?,'m',1,'running',0,?,?)", turnId, draft.id, "test-provider", second.id, Date.now());
  await new Promise(resolve => setTimeout(resolve, 5));
  store.touchConversation(second.id);
  const listed = conversations.list(draft.id);
  assert.equal(listed.currentId, second.id);
  assert.equal(listed.items[0]!.id, second.id);
  assert.equal(listed.items[0]!.activeTurnId, turnId);
  assert.equal(listed.items[0]!.lastTurnStatus, "running");
  assert.equal(listed.items[0]!.title, null);
  assert.equal(listed.items[1]!.id, first.id);
  store.message(draft.id, null, "user", { text: "历史摘要内容" }, first.id);
  const refreshed = conversations.list(draft.id).items.find(item => item.id === first.id)!;
  assert.equal(refreshed.title, "历史摘要内容");
  assert.equal(refreshed.lastUserMessage, "历史摘要内容");
});

test("conversation history commands are exposed over HTTP with stable error codes", async t => {
  const { store, providers, authoring } = setup(t);
  const { app } = createApp(store, providers);
  t.after(async () => { await app.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const other = await authoring.create(undefined, randomUUID());
  const created = (await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations`, payload: { providerId: "test-provider", modelId: "test-model", expectedRevision: 0, requestId: randomUUID() } })).json();
  await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations`, payload: { providerId: "test-provider", modelId: "test-model", expectedRevision: 0, requestId: randomUUID() } });
  // 跨草稿 404。
  assert.equal((await app.inject({ method: "POST", url: `/api/drafts/${other.id}/conversations/${created.id}/archive`, payload: { expectedRevision: 0, requestId: randomUUID() } })).statusCode, 404);
  // 归档当前对话 → 列表无 current；恢复回 current；改名生效。
  const beforeArchive = (await app.inject({ url: `/api/drafts/${draft.id}/conversations` })).json();
  assert.equal((await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations/${beforeArchive.currentId}/archive`, payload: { expectedRevision: 0, requestId: randomUUID() } })).statusCode, 200);
  const list = (await app.inject({ url: `/api/drafts/${draft.id}/conversations` })).json();
  assert.equal(list.currentId, null);
  assert.equal(list.items.find((item: { id: string }) => item.id === created.id).status, "idle");
  const restored = (await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations/${beforeArchive.currentId}/restore`, payload: { expectedRevision: 0, requestId: randomUUID() } })).json();
  assert.equal(restored.status, "current");
  assert.equal((await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations/${created.id}/rename`, payload: { title: "HTTP 改名", expectedRevision: 0, requestId: randomUUID() } })).statusCode, 200);
  // 非法转换 409 + 稳定错误码（current 不能 resume）。
  const conflict = (await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations/${beforeArchive.currentId}/resume`, payload: { expectedRevision: 0, requestId: randomUUID() } }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "CONVERSATION_CONFLICT");
  // 活动轮次阻塞归档（DRAFT_BUSY）。
  store.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at) VALUES(?,?,?,'m',1,'queued',0,?)", randomUUID(), draft.id, "test-provider", Date.now());
  const busy = await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations/${created.id}/archive`, payload: { expectedRevision: 0, requestId: randomUUID() } });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, "DRAFT_BUSY");
  // 消息按会话过滤。
  store.message(draft.id, null, "user", { text: "会话消息" }, created.id);
  const messages = (await app.inject({ url: `/api/drafts/${draft.id}/messages?conversationId=${created.id}` })).json();
  assert.equal(messages.items.length, 1);
});

test("needs_rebuild conversations surface SESSION_REBUILD_REQUIRED over HTTP and rebuild re-enables submission", async t => {
  const { store, providers, authoring } = setup(t);
  const { app } = createApp(store, providers);
  t.after(async () => { await app.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const conversations = authoring.conversations;
  const created = await conversations.create(draft.id, { providerId: "test-provider", modelId: "test-model", ...command() });
  store.markConversation(created.id, "needs_rebuild");
  const rejected = await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/turns`, payload: { providerId: "test-provider", modelId: "test-model", prompt: "继续", expectedRevision: 0, requestId: randomUUID(), conversationId: created.id } });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, "SESSION_REBUILD_REQUIRED");
  const rebuilt = (await app.inject({ method: "POST", url: `/api/drafts/${draft.id}/conversations/${created.id}/rebuild`, payload: { providerId: "test-provider", modelId: "test-model", expectedRevision: 0, requestId: randomUUID() } })).json();
  assert.equal(rebuilt.status, "current");
  assert.equal(rebuilt.rebuildFromId, created.id);
  assert.equal(store.conversation(created.id)!.status, "needs_rebuild");
});
