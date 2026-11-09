import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup } from "./helpers.js";
import { createApp } from "../src/server/app.js";
import { resolveCredentialInputs, type CredentialBindings } from "../src/web-bridge/credential-inputs.js";
import type { BrowserExecution } from "../src/web-bridge/browser-execution.js";
import { validateStoredHttpTool } from "../src/web-bridge/execution.js";

const execution: BrowserExecution = {
  version: 1, transport: "browser", credentialInputs: ["ak", "sk"],
  response: { mode: "fullJson", maxBytes: 262144 },
  preprocess: { runtime: "nodejs", code: `return {path: request.path, method: request.method, headers: {Authorization: credentials.ak, signature: crypto.createHash('md5').update(credentials.sk).digest('hex')}};` },
};

test("credential inputs validate declarations and reject missing, unknown, ambiguous or malformed bindings without echoes", () => {
  validateStoredHttpTool({ path: "/query", method: "GET", parameters: {}, execution });
  for (const credentialInputs of [["ak", "ak"], ["bad-name"], [""], Array.from({length: 21}, (_, i) => `key${i}`)]) {
    assert.throws(() => validateStoredHttpTool({ path: "/query", method: "GET", parameters: {}, execution: { ...execution, credentialInputs } }));
  }
  assert.throws(() => resolveCredentialInputs(["ak"], {}), { code: "CREDENTIAL_UNAVAILABLE" });
  for (const bindings of [null, [], { unknown: { source: "inline", value: "do-not-echo" } },
    { ak: { source: "inline", value: "" } }, { ak: { source: "inline", value: "x".repeat(8193) } },
    { ak: { source: "inline", value: "do-not-echo", dictionaryId: "x", key: "x" } },
    { ak: { source: "unsupported", value: "do-not-echo" } }]) {
    assert.throws(() => resolveCredentialInputs(["ak"], {}, bindings as unknown as CredentialBindings), error => {
      assert.ok(!String(error).includes("do-not-echo")); return true;
    });
  }
  assert.throws(() => resolveCredentialInputs(["ak"], {}, { ak: { source: "dictionary", dictionaryId: "x", key: "x" } }, () => { throw Error("do-not-echo"); }), error => {
    assert.ok(!String(error).includes("do-not-echo")); return true;
  });
});

test("explicit sources override legacy defaults, mix independently and never fall back on failure", () => {
  const defaults = { ak: { dictionaryId: "old", key: "ak" }, sk: { dictionaryId: "old", key: "sk" } };
  const resolve = (id: string, key: string) => `${id}-${key}`;
  assert.deepEqual(resolveCredentialInputs([], defaults, undefined, resolve), { ak: "old-ak", sk: "old-sk" });
  assert.deepEqual(resolveCredentialInputs([], defaults, { ak: { source: "inline", value: "manual" }, sk: { source: "dictionary", dictionaryId: "new", key: "sk" } }, resolve), { ak: "manual", sk: "new-sk" });
  assert.throws(() => resolveCredentialInputs([], defaults, { ak: { source: "dictionary", dictionaryId: "missing", key: "ak" } }, () => { throw Error("missing"); }), { code: "CREDENTIAL_UNAVAILABLE" });
});

test("calls accept dictionary, inline and mixed credentials without persisting, reusing or echoing secrets", async t => {
  const { store, providers } = setup(t);
  const { app, bridge } = createApp(store, providers);
  await app.ready(); t.after(() => app.close());
  bridge.saveApplication({ id: "crm", name: "CRM" });
  bridge.saveEnvironment("crm", { origin: "https://gateway.test", profileId: "work" });
  bridge.browserChannel.register("work", "a".repeat(32));
  bridge.httpDependencies.resolveCredential = (id, key) => {
    assert.equal(id, "chosen-dictionary"); return `dictionary-${key}`;
  };
  bridge.saveTool({ toolId: "query", application: "crm", site: "crm", description: "Query", path: "/query", method: "GET", parameters: { type: "object", additionalProperties: false }, fields: [], risk: "read", approval: "none", timeoutMs: 5000, catalogVersion: "1", enabled: true, execution });
  const before = readFileSync(`${store.root}/config/web-bridge.json`, "utf8");
  const dictionary = (key: string) => ({ source: "dictionary" as const, dictionaryId: "chosen-dictionary", key });
  for (const credentialBindings of [
    { ak: dictionary("ak"), sk: dictionary("sk") },
    { ak: { source: "inline" as const, value: "manual-access" }, sk: { source: "inline" as const, value: "manual-secret" } },
    { ak: dictionary("ak"), sk: { source: "inline" as const, value: "manual-secret" } },
  ]) {
    for (const echo of [false, true]) {
      const pending = app.inject({ method: "POST", url: "/api/web-bridge/calls", payload: { application: "crm", tool: "query", args: {}, credentialBindings } }).then(response => response);
      let items: ReturnType<typeof bridge.browserChannel.poll> = [];
      for (let attempt = 0; !items.length && attempt < 200; attempt++) {
        items = bridge.browserChannel.poll("work");
        if (!items.length) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(items.length, 1);
      const payload = items[0].payload as { request: { headers: Record<string, string> } };
      assert.equal(payload.request.headers.Authorization, credentialBindings.ak.source === "inline" ? "manual-access" : "dictionary-ak");
      assert.ok(!JSON.stringify(payload).includes("manual-secret"));
      bridge.browserChannel.complete("work", items[0].id, echo ? { echo: credentialBindings.sk.source === "inline" ? "manual-secret" : "dictionary-sk" } : { ok: true });
      const response = await pending;
      assert.equal(response.headers["cache-control"], "no-store");
      if (echo) { assert.equal(response.json().code, "SENSITIVE_RESPONSE"); assert.ok(!response.body.includes("manual-secret")); }
      else assert.deepEqual(response.json(), { ok: true });
    }
  }
  const missing = await app.inject({ method: "POST", url: "/api/web-bridge/calls", payload: { application: "crm", tool: "query", args: {} } });
  assert.equal(missing.json().code, "CREDENTIAL_UNAVAILABLE");
  assert.equal(readFileSync(`${store.root}/config/web-bridge.json`, "utf8"), before);
  const malformed = await app.inject({ method: "POST", url: "/api/web-bridge/calls", headers: { "content-type": "application/json" }, payload: '{"credentialBindings":"manual-secret" invalid}' });
  assert.ok(!malformed.body.includes("manual-secret"));
  assert.equal(malformed.headers["cache-control"], "no-store");
});
