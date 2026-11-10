import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { gitProjects } from "../src/project-git/service.js";
import { AppError } from "../src/domain/errors.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function bindingFixture(root: string, projects: ReturnType<typeof gitProjects>) {
  const keys = join(root, "keys"); mkdirSync(keys, { mode: 0o700 });
  writeFileSync(join(keys, "identity"), "disposable-fixture", { mode: 0o600 }); writeFileSync(join(keys, "hosts"), "", { mode: 0o600 });
  projects.files.write(["ssh-profiles.json"], [{ id: "ssh", name: "Test", host: "example.invalid", port: 22, user: "git", identityFile: join(keys, "identity"), knownHostsFile: join(keys, "hosts"), useAgent: false, revision: 1 }]);
  projects.save({ id: "repo", name: "Repo", remoteUrl: "git@example.invalid:repo", branch: "main", sshProfileId: "ssh", enabled: true, acceptedRiskVersion: 1 });
  return projects.binding("repo");
}

test("preparation I/O failure (including ENOSPC) is safe and does not leave a lock or a successful lease", async t => {
  const { root, store } = setup(t); t.after(() => store.close());
  const projects = gitProjects(store); t.after(() => projects.close()); const binding = bindingFixture(root, projects);
  const mock = t.mock.method(projects.files, "directory", () => { throw Object.assign(new Error("sensitive absolute path and ENOSPC"), { code: "ENOSPC" }); });
  await assert.rejects(projects.prepare(binding, "io", "node", "attempt", new AbortController().signal, () => {}), error => {
    assert.equal((error as AppError).code, "PROJECT_IO_FAILED"); assert.ok(!(error as Error).message.includes("sensitive")); return true;
  });
  mock.mock.restore();
  assert.ok(!existsSync(projects.files.path("leases", "io", "node.json")));
  const controller = new AbortController(); controller.abort(new AppError("CANCELLED", "cancelled"));
  await assert.rejects(projects.prepare(binding, "next", "node", "attempt", controller.signal, () => {}), { code: "CANCELLED" });
});

test("cleanup failure retains its lease, emits a safe event and startup/retry later reclaims resources", async t => {
  const { root, store } = setup(t); t.after(() => store.close());
  const projects = gitProjects(store); t.after(() => projects.close()); const binding = bindingFixture(root, projects);
  const controller = new AbortController(); controller.abort(new AppError("CANCELLED", "cancelled"));
  const events: { type: string; payload: unknown }[] = [];
  const mock = t.mock.method(projects.files, "remove", () => { throw new Error("sensitive cleanup path"); });
  await assert.rejects(projects.prepare(binding, "cleanup", "node", "attempt", controller.signal, (type, payload) => events.push({ type, payload })), { code: "CANCELLED" });
  assert.ok(existsSync(projects.files.path("leases", "cleanup", "node.json")));
  assert.ok(events.some(e => e.type === "project.cleanup_failed"));
  assert.ok(!JSON.stringify(events).includes(root)); assert.ok(!JSON.stringify(events).includes("sensitive"));
  mock.mock.restore(); await projects.recover();
  assert.ok(!existsSync(projects.files.path("leases", "cleanup")));
});

test("a cancelled cache-lock waiter does not wait for an unrelated fetch during cleanup", async t => {
  const { root, store } = setup(t); t.after(() => store.close());
  const projects = gitProjects(store); t.after(() => projects.close()); const binding = bindingFixture(root, projects);
  projects.files.directory("cache", "repo", "1");
  const lock = (projects as unknown as { locked<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> }).locked.bind(projects);
  let unlock!: () => void, held = false;
  const holder = lock("repo:1", new AbortController().signal, async () => { held = true; await new Promise<void>(resolve => { unlock = resolve; }); });
  while (!held) await new Promise(resolve => setTimeout(resolve, 1));
  const controller = new AbortController(); let completed = false;
  const waiter = projects.prepare(binding, "waiter", "node", "attempt", controller.signal, () => {}).catch(error => { assert.equal((error as AppError).code, "CANCELLED"); completed = true; });
  controller.abort(new AppError("CANCELLED", "cancelled"));
  try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(completed, true); }
  finally { unlock(); await holder; await waiter; }
});
