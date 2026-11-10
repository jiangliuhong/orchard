import { test } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, linkSync, symlinkSync, openSync, ftruncateSync, closeSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { setup, temporary } from "./helpers.js";
import { StorageUsageService, usageCategory } from "../src/storage/usage.js";
import { gitProjects } from "../src/project-git/service.js";
import { configCoordinator } from "../src/config-git/coordinator.js";

const sum = (values: { allocatedBytes: string | null; logicalBytes: string; fileCount: string }[], key: "allocatedBytes" | "logicalBytes" | "fileCount") => values.reduce((n, item) => n + BigInt(item[key] ?? 0), 0n);

test("storage scan covers hidden/orphan cache, hardlinks, sparse files, symlinks and disjoint categories", async t => {
  const { store, root } = setup(t); t.after(() => store.close());
  const outside = temporary(t); writeFileSync(join(outside, "outside-secret"), Buffer.alloc(100000));
  const cache = join(root, "project-git", "cache", "orphan", "1"); mkdirSync(cache, { recursive: true });
  writeFileSync(join(root, "project-git", "cache", "sensitive-filename.json"), "metadata-only");
  writeFileSync(join(cache, ".hidden"), Buffer.alloc(2048)); linkSync(join(cache, ".hidden"), join(cache, "same-inode"));
  symlinkSync(outside, join(root, "outside-link"));
  const sparse = join(cache, "sparse"), fd = openSync(sparse, "w"); ftruncateSync(fd, 1024 * 1024); closeSync(fd);
  const service = new StorageUsageService(store); t.after(() => service.close());
  const first = service.start(), second = service.start(); assert.equal(first.scanId, second.scanId);
  const view = await service.wait(), result = view.result!;
  assert.equal(view.status, "completed"); assert.equal(result.partial, false);
  assert.equal(sum(result.categories, "allocatedBytes"), BigInt(result.allocatedBytes!));
  assert.equal(sum(result.categories, "logicalBytes"), BigInt(result.logicalBytes));
  assert.equal(sum(result.categories, "fileCount"), BigInt(result.fileCount));
  const project = result.projects.find(p => p.id === "orphan")!;
  const projectCategories = result.categories.filter(c => ["projectCache", "projectTemporary"].includes(c.id));
  assert.equal(sum(result.projects, "allocatedBytes"), sum(projectCategories, "allocatedBytes"));
  assert.equal(sum(result.projects, "logicalBytes"), sum(projectCategories, "logicalBytes"));
  assert.equal(project.name, "orphan"); assert.equal(project.activeLease, false);
  assert.equal(project.logicalBytes, String(2048 + 1024 * 1024)); assert.equal(project.fileCount, "2");
  assert.ok(BigInt(project.allocatedBytes!) < BigInt(project.logicalBytes));
  assert.ok(result.filesystem && BigInt(result.filesystem.totalBytes) > 0n);
  assert.equal(result.dataDir, root);
  assert.ok(!JSON.stringify(result).includes("outside-secret"));
  assert.ok(!JSON.stringify(result).includes("sensitive-filename"));
  assert.equal(usageCategory("workbench.db-wal"), "database"); assert.equal(usageCategory("workbench.db-shm"), "database");
  assert.equal(usageCategory("project-git/cache/orphan/1/.hidden"), "projectCache");
  assert.equal(usageCategory("unknown/file"), "other");
});

test("storage scanner never reads file contents and refuses request-controlled roots", async t => {
  const { store, root } = setup(t); t.after(() => store.close());
  const service = new StorageUsageService(store); t.after(() => service.close());
  const file = join(root, "unreadable"); writeFileSync(file, "never read this content", { mode: 0 });
  service.start(); await service.wait(); assert.ok(service.view().result);
  assert.throws(() => service.get("unknown"), { code: "NOT_FOUND" });
  await service.close(); assert.throws(() => service.start(), { code: "SERVICE_NOT_READY" });
});

test("unsupported allocated metadata is explicit, not confused with logical bytes", async t => {
  const { store } = setup(t); t.after(() => store.close());
  const original = fsPromises.lstat;
  const mock = t.mock.method(fsPromises, "lstat", (async (...args: unknown[]) => {
    const info = await (original as Function)(...args);
    return new Proxy(info, { get(target, key) { return key === "blocks" ? undefined : Reflect.get(target, key); } });
  }) as typeof fsPromises.lstat);
  syncBuiltinESMExports();
  try {
    const service = new StorageUsageService(store); t.after(() => service.close()); service.start(); await service.wait();
    const result = service.view().result!; assert.ok(result); assert.equal(result.allocatedBytes, null);
    assert.ok(BigInt(result.logicalBytes) > 0n); assert.ok(result.categories.every(c => c.allocatedBytes === null));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("permission and filesystem-capacity errors produce safe partial results, never exact zero", async t => {
  const { store, root } = setup(t); t.after(() => store.close());
  const hidden = join(root, "hidden-sensitive-name"); mkdirSync(hidden);
  const original = fsPromises.lstat;
  const stat = t.mock.method(fsPromises, "lstat", (async (...args: unknown[]) => {
    if (String(args[0]) === hidden) throw Object.assign(new Error("sensitive-file-name"), { code: "EACCES" });
    return (original as Function)(...args);
  }) as typeof fsPromises.lstat);
  const capacity = t.mock.method(fsPromises, "statfs", async () => { throw new Error("sensitive-volume-name"); });
  syncBuiltinESMExports();
  try {
    const service = new StorageUsageService(store); t.after(() => service.close()); service.start(); await service.wait();
    const result = service.view().result!; assert.equal(service.view().status, "partial"); assert.equal(result.incomplete, true);
    assert.equal(result.filesystem, null); assert.ok(result.reasons.unreadableOrDisappeared); assert.ok(result.reasons.filesystemUnavailable);
    assert.ok(result.categories.every(c => c.incomplete)); assert.ok(!JSON.stringify(result).includes("sensitive"));
  } finally { stat.mock.restore(); capacity.mock.restore(); syncBuiltinESMExports(); }
});

test("storage scan invalidates mixed configuration results and preserves the previous value", async t => {
  const { store, root } = setup(t); t.after(() => store.close());
  const service = new StorageUsageService(store); t.after(() => service.close());
  service.start(); await service.wait(); const previous = service.view().result;
  const large = join(root, "large"); mkdirSync(large); for (let n = 0; n < 500; n++) writeFileSync(join(large, String(n)), "x");
  service.start(); configCoordinator(store).withWrite(() => {});
  await service.wait(); assert.equal(service.view().status, "failed"); assert.equal(service.view().result, previous);
  configCoordinator(store).setMaintenance("restore"); assert.throws(() => service.start(), { code: "RECOVERY_REQUIRED" });
  configCoordinator(store).setMaintenance(null);
});
