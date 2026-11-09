import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setup, temporary } from "./helpers.js";
import { createApp } from "../src/server/app.js";
import { runSecretsCli } from "../src/secrets/cli.js";
import { parseStrictJson } from "../src/dictionaries/canonical.js";

const host = "127.0.0.1:7441";
const headers = { host, origin: `http://${host}`, "content-type": "application/json" };

test("strict JSON preserves own __proto__ and rejects escaped duplicate keys and raw controls", () => {
  const value = parseStrictJson('{"__proto__":{"safe":true}}') as object;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.throws(() => parseStrictJson('{"__proto__":1,"__proto__":2}'));
  assert.throws(() => parseStrictJson('{"key":1,"\\u006bey":2}'));
  assert.throws(() => parseStrictJson('"raw\nnewline"'));
  assert.equal(parseStrictJson('"escaped\\nnewline"'), "escaped\nnewline");
});

test("management HTTP rejects duplicate keys before conversion without echoing secret fragments", async t => {
  const { store, providers } = setup(t), handle = createApp(store, providers);
  t.after(() => handle.app.close());
  for (const url of ["/api/dictionaries", "/api/secrets/import"]) {
    const response = await handle.app.inject({ method: "POST", url, headers, payload: '{"CANARY-private-field":1,"CANARY-private-field":2}' });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "INVALID_JSON");
    assert.equal(response.body.includes("CANARY"), false);
  }
  const malformedBackup = await handle.app.inject({ method: "POST", url: "/api/secrets/import", headers, payload: {
    requestId: "invalid-backup", expectedGeneration: 0, backupText: '{"CANARY-private-field":42}',
  } });
  assert.equal(malformedBackup.body.includes("CANARY"), false);
  assert.equal(store.all("SELECT * FROM dictionaries").length, 0);
});

test("dictionary pagination never skips the first object of the next page; receipts bind target identity", async t => {
  const { store, providers } = setup(t), handle = createApp(store, providers);
  t.after(() => handle.app.close());
  await handle.app.ready();
  const service = handle.dictionaries;
  const created = Array.from({ length: 4 }, (_, index) => service.create({ requestId: `create-${index}`, name: `配置${index}`, description: "", kind: "plain", enabled: true, operations: [] }));
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = service.list({ limit: 1, cursor });
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
  const change = { requestId: "same-update", expectedRevision: 1, operations: [{ op: "set", key: "flag", type: "boolean", value: true }] };
  service.update(created[0]!.dictionaryId, change);
  assert.throws(() => service.update(created[1]!.dictionaryId, change), { code: "REQUEST_CONFLICT" });
});

test("CLI exports the actual HTTP backup response to 0600 and imports it into an isolated instance", async t => {
  const source = setup(t), sourceApp = createApp(source.store, source.providers);
  const destination = setup(t), destinationApp = createApp(destination.store, destination.providers);
  t.after(async () => { await sourceApp.app.close(); await destinationApp.app.close(); });
  await Promise.all([sourceApp.app.ready(), destinationApp.app.ready()]);
  const key = sourceApp.secrets.generate({ requestId: "generate", expectedGeneration: 0 });
  const outputs: unknown[] = [];
  const transport = (handle: typeof sourceApp) => async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await handle.app.inject({ method: (init?.method ?? "GET") as "GET" | "POST" | "PUT", url: path, headers,
      ...(init?.body ? { payload: String(init.body) } : {}) });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  };
  const root = temporary(t), file = join(root, "backup.json");
  await runSecretsCli(["keyring", "export", "--file", file], { dataDir: source.store.root, request: transport(sourceApp), output: value => outputs.push(value) });
  const backup = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(backup.keys[0].keyId, key.keyId);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(outputs).includes(backup.keys[0].material), false);
  await runSecretsCli(["keyring", "import", "--file", file, "--active-key-id", key.keyId], { dataDir: destination.store.root, request: transport(destinationApp), output: value => outputs.push(value) });
  assert.equal(destinationApp.secrets.status().activeKeyId, key.keyId);
  assert.deepEqual(destinationApp.secrets.keyMaterials().get(key.keyId), sourceApp.secrets.keyMaterials().get(key.keyId));
});
