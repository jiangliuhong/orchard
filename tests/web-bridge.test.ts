import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeMessages, encodeNativeMessage, decodeLine, encodeLine } from "../src/web-bridge/protocol.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { initializeData } from "../src/migrations/runner.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { WebBridgeGateway } from "../src/web-bridge/gateway.js";
import { WebBridgeClient } from "../src/web-bridge/client.js";
import { catalogHash } from "../src/web-bridge/catalog.js";

interface ExtensionProfile { id: string; name: string; extensionId: string }
interface ExtensionReply { ok: boolean; profile?: ExtensionProfile; servers?: string[]; error?: string }
function extensionHarness(stored: Record<string, string> = {}, initiallyAvailable = true, alarms: { name: string; periodInMinutes: number }[] = [], discoveryUrl?: string, initialNativeMode?: "hang" | "disconnect") {
  const source = readFileSync(new URL("../src/web-bridge/extension/background.js", import.meta.url), "utf8");
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const requests: { url: string; profile: ExtensionProfile }[] = [];
  const listeners = new Map<string, (event?: { name: string }) => void>();
  const warnings: string[] = [];
  const timers = new Map<number, () => void>();
  const native = { connections: 0, disconnects: 0 };
  let nextTimer = 0, nativeMode = initialNativeMode;
  let available = initiallyAvailable;
  let onMessage: (message: unknown, sender: { id: string }, sendResponse: (result: ExtensionReply) => void) => boolean | undefined;
  const event = (name: string) => ({ addListener: (listener: (event?: { name: string }) => void) => listeners.set(name, listener) });
  runInNewContext(source, {
    AbortSignal, URL,
    setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 3000); const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    crypto: { randomUUID },
    console: { warn: (message: string) => warnings.push(message) },
    chrome: {
      runtime: {
        connectNative: discoveryUrl || initialNativeMode ? () => {
          native.connections++;
          const messages = new Set<(message: unknown) => void>(), disconnects = new Set<() => void>();
          return {
            onMessage: { addListener: (listener: (message: unknown) => void) => messages.add(listener), removeListener: (listener: (message: unknown) => void) => messages.delete(listener) },
            onDisconnect: { addListener: (listener: () => void) => disconnects.add(listener), removeListener: (listener: () => void) => disconnects.delete(listener) },
            disconnect: () => { native.disconnects++; },
            postMessage: (message: { id: string }) => {
              if (nativeMode === "disconnect") queueMicrotask(() => { for (const listener of disconnects) listener(); });
              else if (nativeMode !== "hang") queueMicrotask(() => { for (const listener of messages) listener({ id: message.id, result: { serverUrl: discoveryUrl } }); });
            },
          };
        } : undefined,
        id: extensionId, onInstalled: event("installed"), onStartup: event("startup"),
        onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
      },
      tabs: { onRemoved: event("tab-removed"), onReplaced: event("tab-replaced"), onUpdated: event("tab-updated") },
      permissions: { onRemoved: event("permission-removed") },
      storage: { local: {
        get: async () => ({ ...stored }),
        set: async (value: Record<string, string>) => { Object.assign(stored, value); },
      } },
      alarms: {
        onAlarm: event("alarm"),
        get: async (name: string) => alarms.findLast(alarm => alarm.name === name),
        create: async (name: string, options: { periodInMinutes: number }) => { alarms.push({ name, ...options }); },
      },
    },
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url, profile: JSON.parse(String(options.body)) });
      return { ok: available && (url.includes(":7443/") || !!discoveryUrl && url.startsWith(`${discoveryUrl}/`)), json: async () => ({}) };
    },
  });
  return {
    requests, listeners, alarms, warnings, stored, native, timers,
    setNativeMode: (mode: typeof nativeMode) => { nativeMode = mode; },
    setAvailable: (value: boolean) => { available = value; },
    send: (message: unknown) => new Promise<ExtensionReply>(resolve => onMessage(message, { id: extensionId }, resolve)),
  };
}

test("extension discovers a custom local service through Native Host and rejects remote discovery results", async () => {
  const extension = extensionHarness({}, true, [], "http://127.0.0.1:7555");
  await extension.send({ type: "profile:register" });
  assert.ok(extension.requests.some(request => request.url === "http://127.0.0.1:7555/api/web-bridge/profiles/register"));
  const untrusted = extensionHarness({}, true, [], "https://evil.test");
  await untrusted.send({ type: "profile:register" });
  assert.equal(untrusted.requests.some(request => request.url.includes("evil.test")), false);
});

test("a stalled Native Host cannot block default HTTP, queued retries, or later discovery recovery", async () => {
  const extension = extensionHarness({}, true, [], "http://127.0.0.1:7555", "hang");
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  assert.equal(extension.requests.length, 2);
  assert.equal(extension.native.connections, 1);
  assert.equal(extension.timers.size, 1);
  const retry = extension.send({ type: "profile:register" });
  for (const timer of [...extension.timers.values()]) timer();
  await tick();
  assert.equal(extension.native.disconnects, 1);
  assert.equal(extension.native.connections, 2);
  assert.equal(extension.requests.length, 4);
  for (const timer of [...extension.timers.values()]) timer();
  const result = await retry;
  assert.deepEqual(Array.from(result.servers ?? []), ["http://127.0.0.1:7443"]);
  assert.equal(extension.native.disconnects, 2);
  assert.equal(extension.timers.size, 0);
  extension.setNativeMode(undefined);
  extension.listeners.get("alarm")!({ name: "orchard-profile-registration" });
  await tick();
  const recovered = await extension.send({ type: "profile:status" });
  assert.ok(recovered.servers!.includes("http://127.0.0.1:7555"));
  assert.equal(extension.native.connections, 3);
  assert.equal(extension.native.disconnects, 3);
  assert.equal(extension.timers.size, 0);
});

test("Native Host disconnect clears its deadline and preserves default HTTP registration", async () => {
  const extension = extensionHarness({}, true, [], undefined, "disconnect");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(extension.requests.length, 2);
  assert.equal(extension.timers.size, 0);
  const status = await extension.send({ type: "profile:status" });
  assert.deepEqual(Array.from(status.servers ?? []), ["http://127.0.0.1:7443"]);
});

test("browser extension retries registration and checks both local services", async () => {
  const { requests, listeners, alarms, warnings, setAvailable } = extensionHarness({}, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(warnings.length, 1);
  assert.deepEqual(alarms, [{ name: "orchard-profile-registration", periodInMinutes: 0.5 }]);
  setAvailable(true);
  listeners.get("alarm")!({ name: "orchard-profile-registration" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 4);
  assert.equal(warnings.length, 1);
  assert.ok(requests[2]!.url.includes(":7441/"));
  assert.ok(requests[3]!.url.includes(":7443/"));
  assert.equal(requests[3]!.profile.extensionId, "abcdefghijklmnopabcdefghijklmnop");
  for (const name of ["startup", "installed"]) {
    listeners.get(name)!();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(requests.length, 8);
});

test("automatic reconnect recovers from service restarts without opening the popup and keeps its alarm across worker restarts", async () => {
  const extension = extensionHarness();
  await new Promise(resolve => setImmediate(resolve));
  const original = await extension.send({ type: "profile:status" });
  assert.equal(original.servers!.length, 1);
  const id = original.profile!.id;
  extension.setAvailable(false);
  extension.listeners.get("alarm")!({ name: "orchard-profile-registration" });
  await new Promise(resolve => setImmediate(resolve));
  const offline = await extension.send({ type: "profile:status" });
  assert.equal(offline.servers!.length, 0);
  extension.setAvailable(true);
  extension.listeners.get("alarm")!({ name: "orchard-profile-registration" });
  await new Promise(resolve => setImmediate(resolve));
  const requestCount = extension.requests.length;
  const restored = await extension.send({ type: "profile:status" });
  assert.equal(restored.servers!.length, 1);
  assert.equal(restored.profile!.id, id);
  assert.equal(extension.requests.length, requestCount);
  const restarted = extensionHarness(extension.stored, true, extension.alarms);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarted.alarms.length, 1);
  assert.equal((await restarted.send({ type: "profile:status" })).profile!.id, id);
});

test("browser profile names and identities survive worker restarts and remain separate across Chrome profiles", async () => {
  const first = extensionHarness();
  const renamed = await first.send({ type: "profile:save", name: "  工作 Chrome  " });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.profile!.name, "工作 Chrome");
  assert.equal(first.stored.profileName, "工作 Chrome");
  const id = renamed.profile!.id;
  const restarted = extensionHarness(first.stored);
  const restored = await restarted.send({ type: "profile:register" });
  assert.equal(restored.profile!.id, id);
  assert.equal(restored.profile!.name, "工作 Chrome");
  const second = extensionHarness();
  const separate = await second.send({ type: "profile:register" });
  assert.notEqual(separate.profile!.id, id);
  assert.equal(separate.profile!.extensionId, restored.profile!.extensionId);
  const blank = await first.send({ type: "profile:save", name: "  " });
  assert.equal(blank.ok, false);
  const tooLong = await first.send({ type: "profile:save", name: "a".repeat(101) });
  assert.equal(tooLong.ok, false);
  assert.equal(first.stored.profileName, "工作 Chrome");
  assert.equal(first.requests.at(-1)!.profile.name, "工作 Chrome");
});

test("extension popup saves names and distinguishes offline saves from successful registration", async t => {
  const extension = extensionHarness();
  const dom = new JSDOM(readFileSync(new URL("../src/web-bridge/extension/popup.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const document = dom.window.document;
  runInNewContext(readFileSync(new URL("../src/web-bridge/extension/popup.js", import.meta.url), "utf8"), {
    document, window: dom.window, chrome: { runtime: { sendMessage: extension.send } },
  });
  await new Promise(resolve => setImmediate(resolve));
  const name = document.getElementById("profile-name") as HTMLInputElement;
  const save = document.getElementById("save") as HTMLButtonElement;
  assert.equal(save.disabled, true);
  assert.ok(name.value.startsWith("Chrome · "));
  const originalId = document.getElementById("profile-id")!.textContent;
  name.value = "工作浏览器";
  document.getElementById("profile-form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(extension.stored.profileName, "工作浏览器");
  assert.equal(document.getElementById("profile-id")!.textContent, originalId);
  assert.equal(document.getElementById("status")!.dataset.state, "success");
  assert.ok(document.getElementById("profile-feedback")!.textContent!.includes("名称已保存"));
  assert.equal(extension.requests.at(-1)!.profile.name, "工作浏览器");
  extension.setAvailable(false);
  name.value = "离线资料";
  document.getElementById("profile-form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(extension.stored.profileName, "离线资料");
  assert.equal(document.getElementById("status")!.dataset.state, "error");
  assert.ok(document.getElementById("status")!.textContent!.includes("尚未连接本机服务"));
  assert.ok(document.getElementById("profile-feedback")!.textContent!.includes("名称已保存"));
  extension.setAvailable(true);
  document.getElementById("reconnect")!.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById("status")!.dataset.state, "success");
});

test("popup automatically displays reconnection without overwriting an unsaved name and stops polling when closed", async t => {
  const extension = extensionHarness({}, false);
  const dom = new JSDOM(readFileSync(new URL("../src/web-bridge/extension/popup.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  runInNewContext(readFileSync(new URL("../src/web-bridge/extension/popup.js", import.meta.url), "utf8"), {
    document,
    window: {
      setTimeout: (callback: () => void, delay: number) => {
        assert.equal(delay, 5000);
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout: (id: number) => { timers.delete(id); },
      addEventListener: dom.window.addEventListener.bind(dom.window),
    },
    chrome: { runtime: { sendMessage: extension.send } },
  });
  await new Promise(resolve => setImmediate(resolve));
  const name = document.getElementById("profile-name") as HTMLInputElement;
  name.value = "尚未保存的名称";
  assert.ok(document.getElementById("status")!.textContent!.includes("自动重连已开启"));
  extension.setAvailable(true);
  extension.listeners.get("alarm")!({ name: "orchard-profile-registration" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  const callback = [...timers.values()][0]!;
  timers.clear();
  callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById("status")!.dataset.state, "success");
  assert.equal(name.value, "尚未保存的名称");
  assert.equal(extension.stored.profileName, undefined);
  assert.equal(timers.size, 1);
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(timers.size, 0);
});

test("popup requires explicit selection of a main bridge tab and identifies the bound tab", async t => {
  const dom = new JSDOM(readFileSync(new URL("../src/web-bridge/extension/popup.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const listener = { addListener() {} };
  const origin = "https://gateway.test";
  const first = { id: 7, windowId: 1, index: 0, title: "工作账号", available: true };
  const second = { ...first, id: 8, index: 1, title: "测试账号", available: true };
  let binding: number | undefined;
  runInNewContext(readFileSync(new URL("../src/web-bridge/extension/popup.js", import.meta.url), "utf8"), {
    document, URL, window: dom.window,
    chrome: {
      permissions: { getAll: async () => ({ origins: [origin + "/*"] }) },
      tabs: { query: async () => [{ url: origin + "/home" }], onUpdated: listener, onRemoved: listener, onReplaced: listener },
      runtime: {
        sendMessage: async (message: { type: string; tabId?: number; origin?: string }) => {
          if (message.type.startsWith("profile:")) return { ok: true, profile: { name: "Chrome", id: "work" }, servers: [] };
          assert.equal(message.origin, origin);
          if (message.type === "tab:bind") binding = message.tabId;
          return { ok: true, tabs: [first, second], tabId: binding, state: binding ? "ready" : "select" };
        },
      },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const select = document.querySelector<HTMLSelectElement>("#bridge-tab")!;
  const button = document.querySelector<HTMLButtonElement>("#bind-tab")!;
  const status = document.getElementById("bridge-tab-status")!;
  assert.equal(select.value, "");
  assert.equal(button.disabled, true);
  assert.match(status.textContent!, /请选择/);
  select.value = "8";
  select.dispatchEvent(new dom.window.Event("change"));
  assert.equal(button.disabled, false);
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(binding, 8);
  assert.equal(select.value, "8");
  assert.match(select.selectedOptions[0]!.textContent!, /测试账号.*主桥接页签/);
  assert.equal(button.disabled, true);
  assert.match(status.textContent!, /已绑定/);
});

test("profile renaming preserves bindings, migrates legacy IDs and expires disconnected profiles", t => {
  const root = mkdtempSync(join(tmpdir(), "orchard-profiles-"));
  initializeData(root, "new_install", randomUUID());
  const config = new WebBridgeConfig(root);
  const bridge = new WebBridgeGateway(new WebBridgeClient(join(root, "bridge.sock"), catalogHash), config);
  t.after(async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); });
  config.saveApplication({ id: "crm", name: "CRM" });
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const environment = config.saveEnvironment("crm", { origin: "https://example.test", profileId: extensionId, bound: true });
  bridge.registerProfile({ id: extensionId, name: "旧资料", extensionId });
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  bridge.registerProfile({ id: "work-profile", name: "工作资料", extensionId });
  bridge.registerProfile({ id: "test-profile", name: "测试资料", extensionId });
  assert.equal(bridge.profilesList().length, 2);
  assert.equal(config.environments("crm")[0]!.id, environment.id);
  assert.equal(config.environments("crm")[0]!.profileId, "work-profile");
  assert.equal(config.environments("crm")[0]!.bound, true);
  bridge.registerProfile({ id: "work-profile", name: "新的工作名称", extensionId });
  assert.equal(bridge.profilesList().length, 2);
  assert.equal(bridge.profilesList().find(profile => profile.id === "work-profile")!.name, "新的工作名称");
  assert.equal(config.environments("crm")[0]!.profileId, "work-profile");
  now += 150000;
  assert.equal(bridge.profilesList().every(profile => !profile.connected), true);
  bridge.registerProfile({ id: "work-profile", name: "新的工作名称", extensionId });
  assert.equal(bridge.profilesList().find(profile => profile.id === "work-profile")!.connected, true);
});

test("native messaging framing handles partial and batched frames", () => {
  const first = encodeNativeMessage({ id: "a", result: 1 }), second = encodeNativeMessage({ id: "b", result: 2 });
  const split = decodeNativeMessages(first.subarray(0, 3));
  assert.deepEqual(split.values, []);
  const complete = decodeNativeMessages(Buffer.concat([split.rest, first.subarray(3), second]));
  assert.deepEqual(complete.values, [{ id: "a", result: 1 }, { id: "b", result: 2 }]);
  assert.equal(complete.rest.length, 0);
});

test("line framing rejects oversized messages and preserves JSON", () => {
  assert.deepEqual(decodeLine(encodeLine({ ok: true }).trim()), { ok: true });
  assert.throws(() => encodeLine({ value: "x".repeat(512 * 1024) }), /BRIDGE_MESSAGE_TOO_LARGE/);
});

test("web bridge config writes restricted environment state atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "orchard-web-bridge-"));
  initializeData(root, "new_install", randomUUID());
  const config = new WebBridgeConfig(root);
  config.saveApplication({ id: "acctrix", name: "Acctrix" });
  const saved = config.saveEnvironment("acctrix", { origin: "https://fm.example.test" });
  assert.equal(config.environments("acctrix")[0]?.origin, "https://fm.example.test");
  assert.throws(() => config.saveEnvironment("acctrix", { origin: "https://fm.example.test/path" }), error => (error as { code?: string }).code === "INVALID_ORIGIN");
  config.setToolEnabled("acctrix", "fm_task_list", false);
  assert.equal(config.toolEnabled("acctrix", "fm_task_list"), false);
  assert.match(readFileSync(join(root, "config", "web-bridge.json"), "utf8"), new RegExp(saved.id));
  const deleted = config.deleteApplication("acctrix");
  assert.equal(deleted.applicationId, "acctrix");
  assert.deepEqual(config.applications(), []);
});
