import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { TestStore, temporary } from "./helpers.js";
import { configuredWebBridge } from "../src/web-bridge/configured.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { BRIDGE_BINDINGS_PATH, bindingKey, readBrowserBindings } from "../src/web-bridge/local-bindings.js";
import { exportSnapshot, localReference, parseSnapshot, serializeSnapshot } from "../src/config-git/snapshot.js";
import { canonicalJson, digest } from "../src/persistence/files.js";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import { WebBridgeGateway } from "../src/web-bridge/gateway.js";
import { WebBridgeClient } from "../src/web-bridge/client.js";

function fixture(t: test.TestContext) {
  const store = new TestStore(temporary(t)); t.after(() => store.close());
  const config = configuredWebBridge(store);
  config.saveApplication({ id: "crm", name: "CRM" });
  return { store, config };
}

test("browser identifiers persist only in the local binding file, survive restart and never enter exported snapshots", t => {
  const { store, config } = fixture(t);
  const env = config.saveEnvironment("crm", { key: "production", origin: "https://example.test", profileId: "MACHINE_PROFILE", extensionId: "MACHINE_EXTENSION" });
  assert.equal(env.profileId, "MACHINE_PROFILE");
  const declaration = store.one<{ config_json: string }>("SELECT config_json FROM bridge_configuration WHERE id='current'")!.config_json;
  assert.equal(declaration.includes("MACHINE_"), false);
  assert.equal(declaration.includes("profileId"), false);
  assert.equal(readBrowserBindings(store.root)[bindingKey("crm", env)]!.profileId, "MACHINE_PROFILE");
  assert.equal(statSync(store.files.path(BRIDGE_BINDINGS_PATH)).mode & 0o777, 0o600);
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, "MACHINE_PROFILE");
  const bundle = exportSnapshot(store, config, "light"), exported = parseSnapshot(bundle.files).webBridge.environments.crm![0]!;
  assert.equal(exported.key, "production");
  assert.equal(Object.hasOwn(exported, "profileId"), false);
  assert.equal(Object.hasOwn(exported, "extensionId"), false);
  assert.equal(JSON.stringify(bundle.files).includes("MACHINE_"), false);
});

test("environment keys are unique within an application, validated and rename without changing UUID or local profile", t => {
  const { store, config } = fixture(t);
  const env = config.saveEnvironment("crm", { key: "production", origin: "https://example.test", profileId: "work" });
  assert.throws(() => config.saveEnvironment("crm", { key: "production", origin: "https://another.test" }), { code: "ENVIRONMENT_KEY_CONFLICT" });
  for (const key of ["", "bad key", "../prod", "x".repeat(101)]) assert.throws(() => config.saveEnvironment("crm", { key, origin: "https://example.test" }), { code: "INVALID_ENVIRONMENT_KEY" });
  config.saveApplication({ id: "other", name: "Other" });
  config.saveEnvironment("other", { key: "production", origin: "https://example.test" });
  const renamed = config.saveEnvironment("crm", { id: env.id, key: "live", origin: env.origin });
  assert.equal(renamed.id, env.id); assert.equal(renamed.profileId, "work");
  assert.equal(readBrowserBindings(store.root)[bindingKey("crm", env)], undefined);
  assert.equal(readBrowserBindings(store.root)[bindingKey("crm", renamed)]!.profileId, "work");
});

test("explicitly unbinding stays unbound after restart; changing origin requires a new local selection", t => {
  const { store, config } = fixture(t);
  const env = config.saveEnvironment("crm", { key: "production", origin: "https://example.test", profileId: "work" });
  config.saveEnvironment("crm", { ...env, profileId: "" });
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, undefined);
  config.saveEnvironment("crm", { ...env, profileId: "work" });
  config.saveEnvironment("crm", { id: env.id, origin: "https://changed.test" });
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, undefined);
  config.saveEnvironment("crm", { id: env.id, origin: "https://changed.test", profileId: "confirmed" });
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, "confirmed");
});

test("legacy locally stored profiles migrate without leaking into new exports or resurrecting an explicit unbind", t => {
  const { store } = fixture(t), path = store.files.path("config/web-bridge.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.applications.crm = { id: "crm", name: "CRM", enabled: true };
  raw.environments.crm = [{ id: "old-env", origin: "https://example.test", profileId: "old-profile", extensionId: "old-extension", enabled: true, bound: true, tabAvailable: true }];
  writeFileSync(path, JSON.stringify(raw));
  const legacy = new WebBridgeConfig(store.root);
  assert.equal(legacy.environments("crm")[0]!.profileId, "old-profile");
  legacy.saveEnvironment("crm", { id: "old-env", key: "production", origin: "https://example.test", profileId: "" });
  assert.equal(new WebBridgeConfig(store.root).environments("crm")[0]!.profileId, undefined);
  assert.equal(readFileSync(path, "utf8").includes("old-profile"), false);
});

test("restoring legacy remote references succeeds without mappings and preserves each machine's own binding", async t => {
  const { store, config } = fixture(t);
  const env = config.saveEnvironment("crm", { id: "shared-uuid", key: "production", origin: "https://example.test", profileId: "LOCAL_ONLY" });
  const source = exportSnapshot(store, config, "light").snapshot;
  source.webBridge.environments.crm![0]!.profileId = localReference("webBridge", "crm", env.id, "profileId");
  source.webBridge.environments.crm![0]!.extensionId = localReference("webBridge", "crm", env.id, "extensionId");
  source.webBridge.applications.crm!.name = "Remote CRM";
  const restore = new ConfigRestoreService(store);
  const plan = await restore.preview(parseSnapshot(serializeSnapshot(source).files), { categories: ["webBridge"] });
  assert.equal((await restore.apply("restore-legacy", plan.token)).phase, "completed");
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, "LOCAL_ONLY");
  assert.equal(configuredWebBridge(store).application("crm")!.name, "Remote CRM");
  const remote = source.webBridge.environments.crm![0]!;
  remote.key = "live";
  const rename = await restore.preview(source, { categories: ["webBridge"] });
  await restore.apply("rename-from-remote", rename.token);
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, "LOCAL_ONLY");
  remote.origin = "https://changed.test";
  await restore.apply("change-origin", (await restore.preview(source, { categories: ["webBridge"] })).token);
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, undefined);
});

test("a new machine restores environment definitions without a browser and reports the missing binding only when executing", async t => {
  const source = fixture(t), targetStore = new TestStore(temporary(t)); t.after(() => targetStore.close());
  source.config.saveEnvironment("crm", { key: "production", origin: "https://example.test", profileId: "SOURCE_MACHINE" });
  const snapshot = exportSnapshot(source.store, source.config, "light").snapshot;
  const restore = new ConfigRestoreService(targetStore);
  await restore.apply("new-machine", (await restore.preview(snapshot, { categories: ["webBridge"] })).token);
  const config = configuredWebBridge(targetStore), env = config.environments("crm")[0]!;
  assert.equal(env.key, "production"); assert.equal(env.profileId, undefined);
  config.saveTool({ application: "crm", toolId: "read", site: "crm", description: "Read", parameters: { type: "object" }, path: "/api", method: "GET", fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", execution: { version: 1, transport: "browser", preprocess: { runtime: "nodejs", code: "return request;" }, response: { mode: "fullJson", maxBytes: 1000 } } });
  const gateway = new WebBridgeGateway(new WebBridgeClient("unused.sock", "catalog"), config); t.after(() => gateway.close());
  await assert.rejects(gateway.call("crm", "read", {}), error => (error as { code: string }).code === "PROFILE_REQUIRED" && /production.*尚未绑定本机浏览器/.test((error as Error).message));
});

test("conflicting remote keys fail before applying configuration and changing a local binding invalidates an old restore plan", async t => {
  const { store, config } = fixture(t);
  const env = config.saveEnvironment("crm", { key: "production", origin: "https://example.test", profileId: "work" });
  const snapshot = exportSnapshot(store, config, "light").snapshot;
  snapshot.webBridge.environments.crm![0]!.id = "different-object";
  const restore = new ConfigRestoreService(store);
  await assert.rejects(restore.preview(snapshot, { categories: ["webBridge"] }), { code: "ENVIRONMENT_KEY_CONFLICT" });
  snapshot.webBridge.environments.crm![0]!.id = env.id;
  const plan = await restore.preview(snapshot, { categories: ["webBridge"] });
  config.saveEnvironment("crm", { ...env, profileId: "other" });
  await assert.rejects(restore.apply("stale-binding", plan.token), { code: "PREVIEW_EXPIRED" });
});

test("legacy database bindings survive a restore interrupted between the database and local-file phases", async t => {
  const { store, config } = fixture(t);
  const raw = JSON.parse(store.one<{ config_json: string }>("SELECT config_json FROM bridge_configuration WHERE id='current'")!.config_json);
  raw.environments.crm = [{ id: "legacy-db-env", origin: "https://example.test", profileId: "LEGACY_DB_PROFILE", enabled: true }];
  const declaration = canonicalJson(raw);
  store.exec("UPDATE bridge_configuration SET config_json=?,content_hash=?,revision=revision+1 WHERE id='current'", declaration, digest(declaration));
  const source = exportSnapshot(store, config, "light").snapshot;
  source.webBridge.applications.crm!.name = "Restored";
  const interrupted = new ConfigRestoreService(store, undefined, { fault(phase) { if (phase === "database_committed_before_journal") throw new Error("lost acknowledgement"); } });
  const plan = await interrupted.preview(source, { categories: ["webBridge"] });
  await assert.rejects(interrupted.apply("legacy-binding-recovery", plan.token), /lost acknowledgement/);
  assert.equal(store.one<{ config_json: string }>("SELECT config_json FROM bridge_configuration WHERE id='current'")!.config_json.includes("LEGACY_DB_PROFILE"), false);
  const recovery = new ConfigRestoreService(store);
  await recovery.recover();
  assert.equal(configuredWebBridge(store).environments("crm")[0]!.profileId, "LEGACY_DB_PROFILE");
  assert.equal(recovery.operations()[0]!.phase, "completed");
});

test("deleting an environment removes its local binding without affecting other applications", t => {
  const { store, config } = fixture(t);
  const env = config.saveEnvironment("crm", { key: "production", origin: "https://example.test", profileId: "work" });
  config.saveApplication({ id: "other", name: "Other" });
  const other = config.saveEnvironment("other", { key: "production", origin: env.origin, profileId: "other" });
  config.deleteEnvironment("crm", env.id);
  assert.equal(readBrowserBindings(store.root)[bindingKey("crm", env)], undefined);
  assert.equal(readBrowserBindings(store.root)[bindingKey("other", other)]!.profileId, "other");
  config.deleteApplication("other");
  assert.deepEqual(readBrowserBindings(store.root), {});
});
