import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { useChatPolling } from "../src/web/agent-chat/useChatPolling.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "HTMLElement", "Node", "navigator"] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { renderHook, cleanup, waitFor } = await import("@testing-library/react");
afterEach(cleanup);

test("polling retries transient failures, clears errors and stops at a terminal result", async () => {
  let calls = 0, successfulCalls = 0, recover = false;
  const { result } = renderHook(() => useChatPolling("turn", async () => {
    calls++;
    if (!recover) throw new Error("temporary network error");
    return { active: ++successfulCalls < 2 };
  }, value => value.active, 20));
  await waitFor(() => assert.equal(result.current.error, "temporary network error"));
  recover = true;
  await waitFor(() => assert.deepEqual(result.current.data, { active: false }));
  assert.equal(result.current.error, "");
  const completedCalls = calls;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, completedCalls);
  assert.equal(successfulCalls, 2);
});

test("key changes and unmount cancel pending retries", async () => {
  const calls: string[] = [];
  const { result, rerender, unmount } = renderHook(({ id }) => useChatPolling(id, async () => {
    calls.push(id);
    throw new Error("offline");
  }, () => true, 80), { initialProps: { id: "old" } });
  await waitFor(() => assert.equal(result.current.error, "offline"));
  rerender({ id: "new" });
  await waitFor(() => assert.ok(calls.includes("new")));
  unmount();
  const count = calls.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls.length, count);
  assert.equal(calls.filter(id => id === "old").length, 1);
});

test("late responses from a previous conversation cannot overwrite the new one", async () => {
  let finish!: (value: string) => void;
  const { result, rerender } = renderHook(({ id }) => useChatPolling(id,
    async () => id === "old" ? new Promise<string>(resolve => { finish = resolve; }) : "new-result",
    () => false, 20), { initialProps: { id: "old" } });
  rerender({ id: "new" });
  await waitFor(() => assert.equal(result.current.data, "new-result"));
  finish("old-result");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(result.current.data, "new-result");
});
