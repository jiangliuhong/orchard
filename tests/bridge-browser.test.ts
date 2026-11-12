import { configuredWebBridge } from "../src/web-bridge/configured.js";
import test from "node:test";
import { setup } from "./helpers.js";
import { createApp } from "../src/server/app.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { BrowserChannel, preprocessBrowser, type BrowserExecution } from "../src/web-bridge/browser-execution.js";
import { validateStoredHttpTool } from "../src/web-bridge/execution.js";

const execution: BrowserExecution = {
  version: 1, transport: "browser", response: { mode: "fullJson", maxBytes: 262144 },
  preprocess: { runtime: "nodejs", credentials: { ak: { dictionaryId: "keys", key: "ak" }, sk: { dictionaryId: "keys", key: "sk" } }, code: `
const body = args.body;
const timestamp = String(Date.now());
const nonce = crypto.randomBytes(16).toString('hex');
const signature = crypto.createHash('md5').update(args.productNo + nonce + args.apiCode + timestamp + credentials.sk + body, 'utf8').digest('hex');
return {path: '/' + encodeURIComponent(args.productNo) + '/request', method: request.method, body, headers: {
  Authorization: 'Bearer ' + credentials.ak, 'X-OS-Api': args.apiCode,
  'Content-Type': 'application/json; charset=utf-8', nonce, timestamp, signature
}};` },
};
const defaults = { path: "/api/outbound", method: "POST" };
const resolver = (_dictionary: string, key: string) => key === "ak" ? "access-key" : "secret-key";

test("browser Node.js preprocessing signs exact UTF-8 with arbitrary argument sources and local milliseconds", async () => {
  validateStoredHttpTool({ ...defaults, parameters: { type: "object" }, execution });
  const args = { productNo: "product", apiCode: "outbound", body: '{ "中文": "😀" }\n' };
  const { request, secrets } = await preprocessBrowser(execution, args, defaults, AbortSignal.timeout(5000), resolver);
  assert.equal(request.path, "/product/request");
  assert.equal(request.body, args.body);
  assert.equal(request.headers.Authorization, "Bearer access-key");
  assert.equal(request.headers.signature, createHash("md5").update(args.productNo + request.headers.nonce + args.apiCode + request.headers.timestamp + "secret-key" + args.body).digest("hex"));
  assert.ok(Math.abs(Date.now() - Number(request.headers.timestamp)) < 5000);
  assert.ok(secrets.includes("secret-key"));
});

test("browser definition uses a concrete default, not unexpanded path templates", () => {
  assert.throws(() => validateStoredHttpTool({ ...defaults, path: "/{productNo}/request", parameters: { type: "object", properties: { productNo: { type: "string" } } }, execution }), { code: "INVALID_PATH" });
});

test("browser preprocessing routes different products without changing its definition", async () => {
  for (const productNo of ["mex_export_user_credit_level_v1", "another_product_v2"]) {
    const { request } = await preprocessBrowser(execution, { productNo, apiCode: "outbound", body: "{}" }, defaults, AbortSignal.timeout(5000), resolver);
    assert.equal(request.path, `/${productNo}/request`);
    assert.equal(request.method, defaults.method);
  }
  for (const productNo of [".", "..", "a/b", "a\\b", "%2f", "a\nb"]) {
    await assert.rejects(preprocessBrowser(execution, { productNo, apiCode: "outbound", body: "{}" }, defaults, AbortSignal.timeout(5000), resolver), { code: "INVALID_PATH" });
  }
});

test("preprocessor rejects cookie overrides, cross-origin targets, method changes and invalid bodies", async () => {
  for (const patch of [{ headers: { Cookie: "x" } }, ...["https://evil.test/x", "//evil.test/x", "/a/../x", "/%2e%2e/x", "/a%2fb", "/a%5cb", "/%252f", "/x?q=1", "/x#fragment"].map(path => ({ path })), { method: "GET" }, { body: {} }]) {
    const modified = { ...execution, preprocess: { runtime: "nodejs" as const, code: `return ${JSON.stringify({ ...defaults, headers: {}, ...patch })}` } };
    await assert.rejects(preprocessBrowser(modified, {}, defaults, AbortSignal.timeout(5000)));
  }
});

test("preprocessor has no inherited environment, refuses filesystem and kills runaway code", async () => {
  const run = (code: string, timeout = 5000) => preprocessBrowser({ ...execution, preprocess: { runtime: "nodejs", code } }, {}, defaults, AbortSignal.timeout(timeout));
  await assert.rejects(run("const fs = await import('node:fs'); fs.readFileSync('/etc/passwd');"), /预处理失败/);
  await assert.rejects(run("while(true) {}", 100), /预处理失败/);
});

test("browser channel authenticates profile and extension, delivers once, isolates responses and cancels", async () => {
  const channel = new BrowserChannel();
  const token = channel.register("work", "a".repeat(32));
  channel.authenticate("work", token, "chrome-extension://" + "a".repeat(32));
  assert.throws(() => channel.authenticate("work", "wrong", undefined));
  assert.throws(() => channel.authenticate("work", token, "chrome-extension://" + "b".repeat(32)));
  const call = channel.call("work", { request: defaults }, AbortSignal.timeout(5000));
  assert.equal(channel.poll("other").length, 0);
  const [item] = channel.poll("work");
  assert.equal(channel.poll("work").length, 0);
  assert.throws(() => channel.complete("other", item.id, {}));
  channel.complete("work", item.id, [1, null]);
  assert.deepEqual(await call, [1, null]);
  const controller = new AbortController();
  const cancelled = channel.call("work", {}, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /取消/);
  assert.equal(channel.poll("work").length, 0);
  const failed = channel.call("work", {}, AbortSignal.timeout(5000));
  channel.complete("work", channel.poll("work")[0].id, undefined, "GATEWAY_AUTH_REQUIRED");
  await assert.rejects(failed, { code: "GATEWAY_AUTH_REQUIRED" });
  channel.close();
});

test("extension sends exact body in same-origin tab with cookies and blocks gateway login responses", async () => {
  const source = readFileSync(new URL("../src/web-bridge/extension/background.js", import.meta.url), "utf8");
  let pageFetch: RequestInit | undefined;
  let status = 200;
  let contentType = "application/json";
  const listener = { addListener() {} };
  const sandbox = {
    AbortSignal, URL, TextDecoder, Uint8Array, location: { origin: "https://gateway.test" },
    console: { warn() {} },
    chrome: {
      runtime: { id: "a".repeat(32), onMessage: listener, onInstalled: listener, onStartup: listener },
      alarms: { onAlarm: listener, get: async () => ({ periodInMinutes: 0.5 }) },
      storage: { local: { get: async () => ({ profileId: "work" }) } },
      tabs: { query: async () => [{ id: 7, url: "https://gateway.test/home", active: true }] },
      scripting: { executeScript: async (options: { world: string; func: (...args: unknown[]) => Promise<unknown>; args: unknown[] }) => {
        assert.equal(options.world, "MAIN");
        return [{ result: await options.func(...options.args) }];
      } },
    },
    fetch: async (url: string, options: RequestInit) => {
      if (String(url).includes("127.0.0.1")) return { ok: false };
      pageFetch = options;
      return new Response(status === 200 ? (contentType === "application/json" ? '{"ok":true}' : '<html>login</html>') : '{}', { status, headers: { "content-type": contentType } });
    },
  };
  runInNewContext(source, sandbox);
  const invoke = () => runInNewContext(`executeBrowserRequest(${JSON.stringify({ origin: "https://gateway.test", request: { ...defaults, body: '{ "中文": 1 }\n', headers: { Authorization: "Bearer ak" } }, maxBytes: 1000, timeoutMs: 1000 })})`, sandbox);
  assert.equal(JSON.stringify(await invoke()), '{"ok":true}');
  assert.equal(pageFetch?.credentials, "include");
  assert.equal(pageFetch?.redirect, "error");
  assert.equal(pageFetch?.body, '{ "中文": 1 }\n');
  status = 401;
  await assert.rejects(invoke(), /GATEWAY_AUTH_REQUIRED/);
  status = 200; contentType = "text/html";
  await assert.rejects(invoke(), /GATEWAY_AUTH_REQUIRED/);
});

test("HTTP browser channel executes reviewed actions only after confirmation, isolates profiles and rejects secret echoes", async t => {
  const { store, providers } = setup(t);
  const { app, bridge } = createApp(store, providers);
  await app.ready(); t.after(() => app.close());
  bridge.saveApplication({ id: "crm", name: "CRM" });
  const origin = "chrome-extension://" + "a".repeat(32);
  const registration = await app.inject({ method: "POST", url: "/api/web-bridge/profiles/register", headers: { origin }, payload: { id: "work", name: "Work", extensionId: "a".repeat(32) } });
  const token = registration.json().bridgeToken;
  assert.equal(typeof token, "string");
  const headers = { origin, "x-orchard-bridge-token": token };
  bridge.saveEnvironment("crm", { origin: "https://gateway.test", profileId: "work" });
  bridge.httpDependencies.resolveCredential = resolver;
  bridge.saveTool({ toolId: "outbound", application: "crm", site: "crm", description: "Outbound", ...defaults, method: "POST", parameters: { type: "object" }, fields: [], risk: "execute", approval: "user", timeoutMs: 5000, catalogVersion: "1", enabled: true,
    execution: { ...execution, postprocess: { runtime: "nodejs", code: "return {items:response,product:args.productNo};" } } });
  assert.equal(configuredWebBridge(store).tools("crm")[0].execution?.transport, "browser");
  const payload = { application: "crm", tool: "outbound", args: { productNo: "p", apiCode: "outbound", body: "{}" } };
  const refused = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload });
  assert.equal(refused.json().code, "APPROVAL_REQUIRED");
  assert.equal((await app.inject({ method: "POST", url: "/api/web-bridge/browser/poll", headers: { origin }, payload: { profileId: "work" } })).statusCode, 401);
  for (const echo of [false, true]) {
    const pending = app.inject({ method: "POST", url: "/api/web-bridge/calls", payload: { ...payload, approved: true } });
    const responsePromise = pending.then(value => value);
    let items: { id: string; payload: { origin: string; request: { path: string; headers: Record<string, string> } } }[] = [];
    for (let attempt = 0; !items.length && attempt < 100; attempt++) {
      items = (await app.inject({ method: "POST", url: "/api/web-bridge/browser/poll", headers, payload: { profileId: "work" } })).json().items;
      if (!items.length) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(items.length, 1);
    assert.equal(items[0].payload.origin, "https://gateway.test");
    assert.equal(items[0].payload.request.path, "/p/request");
    assert.equal(items[0].payload.request.headers.Authorization, "Bearer access-key");
    const completed = await app.inject({ method: "POST", url: "/api/web-bridge/browser/result", headers, payload: { profileId: "work", id: items[0].id, result: echo ? { echo: "secret-key" } : [1, null, { ok: true }] } });
    assert.equal(completed.statusCode, 200);
    const result = await responsePromise;
    if (echo) { assert.equal(result.json().code, "SENSITIVE_RESPONSE"); assert.ok(!result.body.includes("secret-key")); }
    else assert.deepEqual(result.json(), { items: [1, null, { ok: true }], product: "p" });
  }
});
