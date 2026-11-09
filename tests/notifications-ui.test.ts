import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "Event", "localStorage", "navigator"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { NotificationSettings, BrowserNotifications, notificationStorageKey } = await import("../src/web/lib/notifications.js");
let permission: NotificationPermission = "default", requests = 0;
const delivered: string[] = [];
class FakeNotification {
  static get permission() { return permission; }
  static async requestPermission() { requests++; permission = "granted"; return permission; }
  constructor(title: string) { delivered.push(title); }
}
class FakeSource {
  static latest: FakeSource;
  onmessage?: (event: { data: string }) => void;
  closed = false;
  constructor(readonly url: string) { FakeSource.latest = this; }
  close() { this.closed = true; }
}
Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeSource });
afterEach(() => { cleanup(); localStorage.clear(); permission = "default"; requests = 0; delivered.length = 0; });

test("notifications default off; permission requested only on enabling, preference persists and disables stream", async () => {
  render(createElement("div", null, createElement(NotificationSettings), createElement(BrowserNotifications)));
  const toggle = screen.getByRole("checkbox", { name: "启用浏览器通知" }) as HTMLInputElement;
  assert.equal(toggle.checked, false);
  assert.equal(requests, 0);
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.checked, true));
  assert.equal(requests, 1);
  assert.equal(localStorage.getItem(notificationStorageKey), "true");
  const source = FakeSource.latest;
  const event = { data: JSON.stringify({ id: "1", key: "unique", title: "Agent 已完成", body: "点击查看详情", url: "/drafts/a" }) };
  source.onmessage?.(event); source.onmessage?.(event);
  assert.deepEqual(delivered, ["Agent 已完成"]);
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(source.closed, true));
  assert.equal(localStorage.getItem(notificationStorageKey), "false");
});

test("denied permission and unsupported browser have explicit disabled states", () => {
  permission = "denied";
  const view = render(createElement(NotificationSettings));
  assert.equal((screen.getByRole("checkbox") as HTMLInputElement).disabled, true);
  assert.ok(screen.getByText(/已被浏览器阻止/));
  view.unmount();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  render(createElement(NotificationSettings));
  assert.ok(screen.getByText(/不支持通知/));
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});
