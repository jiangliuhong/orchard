import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { setup, exampleFiles } from "./helpers.js";
import { createApp } from "../src/server/app.js";
import { dictionaryDependencyMetadata, validateDictionaryRequirements } from "../src/dictionaries/validation.js";
import { DictionaryExecution } from "../src/dictionaries/execution.js";
import { exportDictionaries, prepareDictionaries } from "../src/config-git/dictionaries.js";

async function harness(t: TestContext) {
  const { store, providers } = setup(t), handle = createApp(store, providers);
  t.after(async () => { await handle.app.close(); store.close(); });
  await handle.app.ready();
  const service = handle.dictionaries;
  const create = (kind: "plain" | "encrypted" = "plain") => service.create({ requestId: randomUUID(), name: `Config-${randomUUID()}`, description: "", kind, enabled: true, operations: [{ op: "set", key: "token", type: "string", value: "private-value" }] });
  const remove = (id: string, expectedRevision: number, extra = {}) => service.remove(id, { requestId: randomUUID(), expectedRevision, ...extra });
  return { store, service, app: handle.app, create, remove };
}

test("字典删除：软删除保留历史，阻止修改/绑定/静默导入；彻底删除幂等且释放名称", async t => {
  const { store, service, create, remove } = await harness(t);
  const { dictionaryId: id, versionId } = create(), name = service.get(id)!.name;
  const portable = exportDictionaries(store);
  assert.throws(() => remove(id, 1, { permanent: true, confirmationName: name }), { code: "DICTIONARY_DELETE_STATE" });
  assert.throws(() => remove(id, 5), { code: "REVISION_CONFLICT" });
  const soft = { requestId: randomUUID(), expectedRevision: 1 };
  const result = service.remove(id, soft);
  assert.deepEqual(service.remove(id, soft), result);
  assert.equal(service.get(id)!.revision, 2);
  assert.ok(service.get(id)!.deletedAt);
  assert.equal(service.list().items.length, 0);
  assert.equal(service.list({ deleted: true }).items[0]!.id, id);
  assert.deepEqual(service.version(id, versionId)!.keys.token, { type: "string", value: "private-value" });
  assert.equal(dictionaryDependencyMetadata(store).length, 0);
  assert.equal(exportDictionaries(store).length, 0);
  assert.throws(() => prepareDictionaries(store, portable), { code: "DICTIONARY_DELETED" });
  assert.throws(() => validateDictionaryRequirements(store, [{ dictionaryId: id, kind: "plain", keys: ["token"] }]), { code: "DICTIONARY_NOT_FOUND" });
  assert.throws(() => service.update(id, { requestId: randomUUID(), expectedRevision: 2, operations: [] }), { code: "DICTIONARY_DELETED" });
  assert.throws(() => remove(id, 2, { permanent: true, confirmationName: "wrong" }), { code: "CONFIRMATION_REQUIRED" });
  const hard = { requestId: randomUUID(), expectedRevision: 2, permanent: true, confirmationName: name };
  const purged = service.remove(id, hard);
  assert.deepEqual(service.remove(id, hard), purged);
  assert.equal(service.get(id), null);
  assert.equal(store.one("SELECT id FROM dictionary_versions WHERE dictionary_id=?", id), undefined);
  assert.equal(store.all("PRAGMA foreign_key_check").length, 0);
  assert.equal(store.one("PRAGMA defer_foreign_keys")!.defer_foreign_keys, 0);
  assert.ok(service.create({ requestId: randomUUID(), name, description: "", kind: "plain", enabled: true, operations: [] }));
});

test("字典删除：当前/历史凭据引用与不完整扫描均受保护", async t => {
  const { store, service, create, remove } = await harness(t);
  const { dictionaryId: id } = create();
  const w = JSON.parse(exampleFiles("consumer")["workflow.json"]!);
  w.nodes[0].type = "web-bridge";
  w.nodes[0].config = { application: "app", tool: "read", credentialBindings: { auth: { source: "dictionary", dictionaryId: id, key: "token" } } };
  store.exec("INSERT INTO workflows VALUES('consumer','consumer',NULL,1,1)");
  const files = { ...exampleFiles("consumer"), "workflow.json": JSON.stringify(w) };
  const tree = store.files.saveTree(files);
  store.exec("INSERT INTO workflow_versions VALUES('wv','consumer',1,?,'{}',?,?,1)", JSON.stringify(w), tree.path, tree.hash);
  store.exec("UPDATE workflows SET current_version_id='wv' WHERE id='consumer'");
  assert.equal(service.referenceList(id).complete, true);
  assert.throws(() => remove(id, 1), { code: "DICTIONARY_REFERENCED" });
  store.exec("UPDATE workflows SET current_version_id=NULL WHERE id='consumer'");
  remove(id, 1);
  assert.throws(() => remove(id, 2, { permanent: true, confirmationName: service.get(id)!.name }), { code: "DICTIONARY_REFERENCED" });
  const second = create().dictionaryId;
  store.db.exec("INSERT INTO drafts(id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES('broken',0,'not/a/tree','{}','draft',1,1)");
  assert.throws(() => remove(second, 1), { code: "REFERENCE_SCAN_INCOMPLETE" });
  assert.equal(service.get(second)!.deletedAt, null);
});

test("字典删除：测试绑定保留并阻止彻底删除，数据库触发器同样保护", async t => {
  const { store, service, create, remove } = await harness(t);
  const { dictionaryId: id, versionId } = create();
  store.exec("INSERT INTO scripts VALUES('s','test','','nodejs','draft',NULL,NULL,1,1,NULL)");
  store.exec("INSERT INTO script_tests VALUES('t','s',NULL,0,'succeeded','{}',NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL)");
  store.exec("INSERT INTO script_test_dictionary_bindings VALUES('t',?,?,'[\"token\"]',1)", id, versionId);
  remove(id, 1);
  assert.throws(() => remove(id, 2, { permanent: true, confirmationName: service.get(id)!.name }), { code: "DICTIONARY_BOUND" });
  assert.throws(() => store.transaction(() => store.exec("DELETE FROM dictionary_versions WHERE dictionary_id=?", id)), /DICTIONARY_VERSION_IMMUTABLE/);
  assert.ok(store.one("SELECT id FROM script_tests WHERE id='t'"));
  assert.ok(service.version(id, versionId));
  const execution = new DictionaryExecution(store);
  const requirements = [{ dictionaryId: id, kind: "plain" as const, keys: ["token"] }];
  assert.equal(execution.load("test", "t", requirements).plain(id, "token"), "private-value");
  assert.throws(() => execution.validate(requirements), { code: "DICTIONARY_NOT_FOUND" });
  // 仅运行绑定也必须阻止删除，不依赖 script_test_dictionary_bindings。
  store.exec("DELETE FROM script_tests WHERE id='t'");
  store.exec("INSERT INTO workflows VALUES('w','history',NULL,1,1)");
  store.exec("INSERT INTO workflow_versions VALUES('v','w',1,?,'{}','unused','hash',1)", exampleFiles("w")["workflow.json"]!);
  store.exec("INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES('r','v','succeeded','{}',1)");
  store.exec("INSERT INTO run_dictionary_bindings VALUES('r',?,?,'[\"token\"]',1)", id, versionId);
  assert.throws(() => remove(id, 2, { permanent: true, confirmationName: service.get(id)!.name }), { code: "DICTIONARY_BOUND" });
  assert.equal(execution.load("run", "r", requirements).plain(id, "token"), "private-value");
});

test("字典删除 HTTP：严格校验、来源保护、缺失密钥仍可删除加密字典", async t => {
  const { service, app, create } = await harness(t);
  service.secrets.generate({ requestId: randomUUID(), expectedGeneration: 0 });
  const { dictionaryId: id } = create("encrypted"), name = service.get(id)!.name;
  rmSync(service.secrets.keyring.path);
  const payload = { requestId: randomUUID(), expectedRevision: 1 };
  const headers = { host: "127.0.0.1:7441", origin: "http://127.0.0.1:7441", "sec-fetch-site": "same-origin" };
  const request = (body: object, h = headers) => app.inject({ method: "DELETE", url: `/api/dictionaries/${id}`, headers: h, payload: body });
  assert.equal((await request(payload, { ...headers, origin: "http://127.0.0.1:9999" })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/dictionaries/${id}`, payload })).statusCode, 401);
  assert.equal((await request({ ...payload, extra: true })).statusCode, 400);
  assert.equal((await request(payload)).statusCode, 200);
  const deleted = await app.inject({ url: "/api/dictionaries?deleted=true" });
  assert.equal(deleted.json().items[0].id, id);
  const hard = { requestId: randomUUID(), expectedRevision: 2, permanent: true, confirmationName: name };
  assert.equal((await request(hard)).statusCode, 200);
  assert.equal((await request(hard)).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/dictionaries/${id}` })).statusCode, 404);
});
