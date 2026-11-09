import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeHttpTool, type BridgeHttpExecution, type HttpTool } from "../src/web-bridge/execution.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { createApp } from "../src/server/app.js";
import { validatePortableBridge } from "../src/config-git/snapshot-validation.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac } from "../src/secrets/command-hmac.js";
import { SecretsService } from "../src/secrets/service.js";
import { DictionaryService } from "../src/dictionaries/service.js";
import { setup } from "./helpers.js";
import type { WebBridgeTool } from "../src/web-bridge/catalog.js";

const signing = (): NonNullable<BridgeHttpExecution["signing"]> => ({
  algorithm: "md5", dictionaryId: "credentials", akKey: "ak", skKey: "sk",
  parts: ["ak", "sk", "nonce", "timestamp", "path", "body"], separator: "|", digestCase: "upper", nonceBytes: 16, timestampUnit: "seconds",
  headers: { ak: "X-AK", nonce: "X-Nonce", timestamp: "X-Time", signature: "X-Signature" },
});
const tool = (): HttpTool => ({ path: "/{productNo}/request", method: "POST", fields: ["items"], execution: {
  version: 1, transport: "localHttp", body: { mode: "rawUtf8", argument: "body" }, response: { mode: "fullJson", maxBytes: 262144 },
} });
const definition = (): WebBridgeTool => ({ ...tool(), toolId: "credit", application: "crm", site: "crm", description: "查询",
  parameters: { type: "object", required: ["productNo", "body"], properties: { productNo: { type: "string" }, body: {} }, additionalProperties: false },
  risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true,
});
const credentials = (_dictionary: string, key: string) => key === "ak" ? "test-access-key" : "test-secret-key";
const run = (value: HttpTool, args = { productNo: "p1", body: "{}" }, request: typeof fetch = async () => Response.json({ items: [], nested: { all: true } })) =>
  executeHttpTool(value, "https://example.test", args, new AbortController().signal, { fetch: request, resolveCredential: credentials, now: () => 1700000000000, nonce: () => "a".repeat(32) });

test("local HTTP signs exactly the UTF-8 bytes sent, with encoded dynamic path and controlled headers", async () => {
  const value = tool(); value.execution.signing = signing();
  const body = '{ "中文": " 空格 ",\n "array": [null,1] }';
  let calls = 0;
  const result = await run(value, { productNo: "产品-v1", body }, async (url, options) => {
    calls++;
    assert.equal(String(url), "https://example.test/%E4%BA%A7%E5%93%81-v1/request");
    assert.equal(options?.body, body);
    const headers = new Headers(options?.headers);
    const source = ["test-access-key", "test-secret-key", "a".repeat(32), "1700000000", "/%E4%BA%A7%E5%93%81-v1/request", body].join("|");
    assert.equal(headers.get("x-signature"), createHash("md5").update(Buffer.from(source, "utf8")).digest("hex").toUpperCase());
    assert.equal(headers.get("x-ak"), "test-access-key");
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "omit");
    assert.ok(!JSON.stringify(options).includes("test-secret-key"));
    return Response.json({ items: [null], nested: { all: true } });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { items: [null], nested: { all: true } });
});

test("JSON body serialization and same-origin clock synchronization are explicit", async () => {
  const value = tool(); value.execution.body!.mode = "json";
  value.execution.signing = { ...signing(), clock: { path: "/time", field: "timestamp", unit: "milliseconds" } };
  const calls: string[] = [];
  await executeHttpTool(value, "https://example.test", { productNo: "p", body: { n: 1, text: "中" } }, new AbortController().signal, {
    now: () => 0, nonce: () => "a".repeat(32), resolveCredential: credentials,
    fetch: async (url, options) => {
      calls.push(String(url));
      if (String(url).endsWith("/time")) { assert.equal(options?.headers, undefined); return Response.json({ timestamp: 1700000000000 }); }
      assert.equal(options?.body, '{"n":1,"text":"中"}');
      assert.equal(new Headers(options?.headers).get("x-time"), "1700000000");
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(calls, ["https://example.test/time", "https://example.test/p/request"]);
});

test("path traversal, missing arguments and invalid origins fail before sending", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json({}); };
  for (const productNo of ["..", ".", "../evil", "%2e%2e", "//evil.test", "a\\b", "", "a\n"]) {
    await assert.rejects(run(tool(), { productNo, body: "{}" }, request));
  }
  for (const origin of ["https://user:pass@example.test", "https://example.test/path", "http://remote.test"]) {
    await assert.rejects(executeHttpTool(tool(), origin, { productNo: "p", body: "{}" }, new AbortController().signal, { fetch: request }));
  }
  await assert.rejects(run(tool(), { productNo: "p", body: "\ud800" }, request), { code: "INVALID_BODY" });
  assert.equal(calls, 0);
});

test("full JSON preserves scalar/array/null and fields remain a literal whitelist", async () => {
  for (const result of [null, [1, { nested: true }], false, 0, "hello"]) {
    assert.deepEqual(await run(tool(), undefined, async () => Response.json(result)), result);
  }
  const value = tool(); value.execution.response.mode = "fields";
  assert.deepEqual(await run(value), { items: [] });
  value.fields = []; assert.deepEqual(await run(value), {});
  value.fields = ["*"]; assert.deepEqual(await run(value), {});
});

test("oversized, malformed, redirected and credential-echo responses are refused without leaks", async () => {
  const small = tool(); small.execution.response.maxBytes = 8;
  await assert.rejects(run(small), { code: "RESPONSE_TOO_LARGE" });
  await assert.rejects(run(tool(), undefined, async () => new Response("not JSON")), { code: "INVALID_RESPONSE" });
  await assert.rejects(run(tool(), undefined, async () => new Response("", { status: 302 })), { code: "HTTP_REQUEST_FAILED" });
  const signed = tool(); signed.execution.signing = signing();
  await assert.rejects(run(signed, undefined, async () => Response.json({ echo: "test-secret-key" })), { code: "SENSITIVE_RESPONSE" });
  await assert.rejects(run(signed, undefined, async () => { throw new Error("test-secret-key secret error"); }), error => {
    assert.equal((error as { code: string }).code, "HTTP_EXECUTION_FAILED");
    assert.ok(!(error as Error).message.includes("secret")); return true;
  });
});

test("gateway routes real HTTP calls by environment, resolves encrypted credentials, preserves old tools and reloads", async t => {
  const { store, providers } = setup(t);
  const keyring = new KeyringStore(resolveKeyringPath(store.root));
  const secrets = new SecretsService(store, keyring, new CommandHmac(store, store.root, keyring));
  secrets.generate({ requestId: "generate", expectedGeneration: 0 });
  const dictionaries = new DictionaryService(store, secrets);
  const dictionary = dictionaries.create({ requestId: "credentials", name: "HTTP 凭据", description: "", kind: "encrypted", enabled: true,
    operations: [{ op: "set", key: "ak", type: "string", value: "test-access-key" }, { op: "set", key: "sk", type: "string", value: "test-secret-key" }],
  });
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.url, "/product-2/request");
    assert.equal(req.headers["x-ak"], "test-access-key");
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const source = ["test-access-key", "test-secret-key", req.headers["x-nonce"], req.headers["x-time"], req.url, body].join("|");
      assert.equal(req.headers["x-signature"], createHash("md5").update(source).digest("hex").toUpperCase());
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: [null, { credit: 5 }], extra: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { app, bridge } = createApp(store, providers); await app.ready(); t.after(() => app.close());
  bridge.saveApplication({ id: "crm", name: "CRM" });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const environment = bridge.saveEnvironment("crm", { origin });
  const value = definition(); value.execution!.signing = { ...signing(), dictionaryId: dictionary.dictionaryId };
  bridge.saveTool(value);
  assert.deepEqual(JSON.parse(JSON.stringify(new WebBridgeConfig(store.root).tools("crm"))), [value]);
  const args = { productNo: "product-2", body: '{ "中文": true }' };
  const payload = { application: "crm", tool: "credit", args };
  let response = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { result: [null, { credit: 5 }], extra: true });
  bridge.saveEnvironment("crm", { origin: "https://other.test" });
  response = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload });
  assert.equal(response.json().code, "ENVIRONMENT_REQUIRED"); assert.equal(requests, 1);
  response = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload: { ...payload, environmentId: environment.id } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(requests, 2);
  bridge.saveTool({ ...value, risk: "write", approval: "user" });
  await assert.rejects(bridge.call("crm", "credit", args), { code: "APPROVAL_REQUIRED" });
  assert.equal(requests, 2);
  const text = readFileSync(join(store.root, "config/web-bridge.json"), "utf8");
  assert.ok(!text.includes("test-secret-key") && !text.includes("test-access-key"));
});

test("HTTP definitions reject unsupported code, header overrides and undeclared templates atomically", t => {
  const { store } = setup(t); t.after(() => store.close());
  const config = new WebBridgeConfig(store.root); config.saveApplication({ id: "crm", name: "CRM" });
  config.saveTool(definition()); const before = config.authoringSnapshot("crm").hash;
  const portable = { applications: { crm: { id: "crm", name: "CRM", enabled: true } }, environments: {}, tools: { "crm/credit": definition() }, enabledTools: {} };
  assert.doesNotThrow(() => validatePortableBridge(portable));
  assert.throws(() => validatePortableBridge({ ...portable, tools: { "crm/credit": { ...definition(), execution: { version: 1 } } } }));
  const invalid = [
    { ...definition(), path: "/{missing}/request" },
    { ...definition(), execution: { ...tool().execution, code: "eval()" } },
    { ...definition(), execution: { ...tool().execution, signing: { ...signing(), headers: { ...signing().headers, ak: "Cookie" } } } },
    { ...definition(), execution: { ...tool().execution, signing: { ...signing(), headers: { ...signing().headers, ak: "x-time" } } } },
    { ...definition(), execution: { ...tool().execution, signing: { ...signing(), clock: { path: "/../time", field: "time", unit: "seconds" } } } },
  ];
  for (const candidate of invalid) {
    assert.throws(() => config.saveTool(candidate as WebBridgeTool));
    assert.equal(config.authoringSnapshot("crm").hash, before);
  }
  const legacy = definition(); delete legacy.execution; legacy.path = "/fixed/request";
  config.saveTool(legacy);
  assert.equal(config.tools("crm")[0].execution, undefined);
  assert.equal(new WebBridgeConfig(store.root).tools("crm")[0].execution, undefined);
});

test("timeouts and cancellation abort the actual HTTP request", async () => {
  for (const signal of [AbortSignal.timeout(10), AbortSignal.abort()]) {
    const pending = executeHttpTool(tool(), "https://example.test", { productNo: "p", body: "{}" }, signal, {
      fetch: async (_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true })),
    });
    // Keep Node alive while the unref'ed timeout signal fires.
    const keepAlive = setTimeout(() => {}, 100);
    try { await assert.rejects(pending, { code: signal.reason?.name === "AbortError" ? "CANCELLED" : "HTTP_TIMEOUT" }); }
    finally { clearTimeout(keepAlive); }
  }
});
