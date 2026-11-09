import { test } from "node:test";
import assert from "node:assert/strict";
import { NotificationFeed } from "../src/server/notifications.js";
import { createApp } from "../src/server/app.js";
import { setup } from "./helpers.js";

test("completion feed filters active states, deduplicates terminal updates and replays missed events", () => {
  const feed = new NotificationFeed();
  const cursor = feed.cursor;
  feed.complete("a", "running", "Agent ", "/drafts/a");
  assert.deepEqual(feed.after(cursor), []);
  feed.complete("a", "succeeded", "Agent ", "/drafts/a");
  feed.complete("a", "succeeded", "Agent ", "/drafts/a");
  feed.complete("b", "failed", "工作流执行", "/runs/b");
  const items = feed.after(cursor);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.title, "Agent 已完成");
  assert.equal(items[1]?.title, "工作流执行失败");
  assert.notEqual(items[0]?.key, items[1]?.key);
  assert.deepEqual(feed.after(items[0]!.id), [items[1]]);
  assert.deepEqual(feed.after(feed.cursor), []);
});

test("global SSE delivers terminal events and replays on reconnect without replaying history to new listeners", async context => {
  const { store, providers } = setup(context);
  const { app } = createApp(store, providers);
  context.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  context.after(() => controller.abort());
  const response = await fetch(`${address}/api/notifications/stream`, { signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /connected/);
  const emit = (id: string) => store.events.emit("event", { streamType: "run", streamId: id, type: "run.succeeded" });
  emit("first");
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /工作流执行已完成/);
  assert.match(first, /\/runs\/first/);
  await reader.cancel();
  emit("second");
  const replay = await fetch(`${address}/api/notifications/stream`, { headers: { "Last-Event-ID": "1" }, signal: controller.signal });
  const replayReader = replay.body!.getReader();
  const chunk = decoder.decode((await replayReader.read()).value);
  assert.match(chunk, /\/runs\/second/);
  assert.doesNotMatch(chunk, /\/runs\/first/);
  await replayReader.cancel();
  const fresh = await fetch(`${address}/api/notifications/stream`, { signal: controller.signal });
  const freshReader = fresh.body!.getReader();
  assert.doesNotMatch(decoder.decode((await freshReader.read()).value), /\/runs\//);
  await freshReader.cancel();
});

test("completion replay is bounded", () => {
  const feed = new NotificationFeed();
  for (let i = 0; i < 510; i++) feed.complete(String(i), "cancelled", "Agent ", "/scripts/a");
  assert.equal(feed.after("0").length, 500);
  assert.equal(feed.after("0")[0]?.id, "11");
});
