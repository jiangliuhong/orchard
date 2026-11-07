import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { readSnapshotDirectory, runConfigGitCli, snapshotDirectory, validateSnapshotDirectory } from "../src/config-git/cli.js";
import { serializeSnapshot } from "../src/config-git/snapshot.js";
import type { PortableSnapshot } from "../src/config-git/snapshot-types.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "orchard-config-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const snapshot: PortableSnapshot = {
  general: { theme: "system" }, providers: [], scripts: [], workflows: [],
  webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} },
};
function populate(directory: string) {
  const bundle = serializeSnapshot(snapshot);
  for (const [path, contents] of Object.entries(bundle.files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  }
  return bundle;
}

test("CLI validates snapshot and atomically refreshes edited declarations without modifying source", t => {
  const directory = fixture(t);
  populate(directory);
  assert.equal(validateSnapshotDirectory(directory).valid, true);
  const source = join(directory, "settings/general.config.ts");
  const updated = readFileSync(source, "utf8").replace('"system"', '"dark"');
  writeFileSync(source, updated);
  assert.throws(() => validateSnapshotDirectory(directory));
  assert.equal(validateSnapshotDirectory(directory, true).refreshed, true);
  assert.equal(validateSnapshotDirectory(directory).valid, true);
  assert.equal(readFileSync(source, "utf8"), updated);
});

test("CLI process validates offline and reports failures with a nonzero exit code", t => {
  const directory = fixture(t);
  populate(directory);
  const cli = new URL("../src/cli/index.ts", import.meta.url).pathname;
  const invoke = () => spawnSync(process.execPath, ["--import", "tsx", cli, "config-git", "validate", "--directory", directory, "--data-dir", join(directory, "unused-data")], { encoding: "utf8" });
  const valid = invoke();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  writeFileSync(join(directory, "extra.txt"), "not in manifest");
  const invalid = invoke();
  assert.equal(invalid.status, 1);
  assert.equal(typeof JSON.parse(invalid.stderr).code, "string");
});

test("failed refresh preserves original manifest and never executes declarations", t => {
  const directory = fixture(t);
  populate(directory);
  const original = readFileSync(join(directory, "manifest.json"), "utf8");
  writeFileSync(join(directory, "settings/general.config.ts"), 'export default {theme: (() => { throw new Error("EXECUTED"); })()};\n');
  assert.throws(() => validateSnapshotDirectory(directory, true));
  assert.equal(readFileSync(join(directory, "manifest.json"), "utf8"), original);
});

test("directory reader rejects symlinks including ancestors, traversal, git entries, and invalid UTF-8", t => {
  const root = fixture(t);
  const real = join(root, "real"); mkdirSync(real);
  writeFileSync(join(real, "source"), "safe");
  const linked = join(root, "linked"); symlinkSync(real, linked);
  assert.throws(() => readSnapshotDirectory(linked));
  mkdirSync(join(real, "nested"));
  assert.throws(() => readSnapshotDirectory(join(linked, "nested")));
  assert.throws(() => readSnapshotDirectory(`${real}/../real`));
  symlinkSync(join(real, "source"), join(real, "link"));
  assert.throws(() => readSnapshotDirectory(real));
  rmSync(join(real, "link"));
  mkdirSync(join(real, ".git"));
  assert.throws(() => readSnapshotDirectory(real));
  rmSync(join(real, ".git"), { recursive: true });
  writeFileSync(join(real, "source"), Buffer.from([0xff]));
  assert.throws(() => readSnapshotDirectory(real), /UTF-8/);
  truncateSync(join(real, "source"), 64 * 1024 * 1024 + 1);
  assert.throws(() => readSnapshotDirectory(real), /size limits/);
});

test("validation resolves only explicit directory or bound managed repository", t => {
  const root = fixture(t);
  mkdirSync(join(root, "config-git"));
  const bindingPath = join(root, "config-git/binding.json");
  writeFileSync(bindingPath, JSON.stringify({ id: "binding", configDir: "orchard-config" }));
  assert.equal(snapshotDirectory(root), join(root, "config-git/repositories/binding/orchard-config"));
  assert.equal(snapshotDirectory(root, root), root);
  for (const binding of [{ id: "../escape", configDir: "safe" }, { id: "safe", configDir: "../escape" }, { id: "safe", configDir: "/escape" }]) {
    writeFileSync(bindingPath, JSON.stringify(binding));
    assert.throws(() => snapshotDirectory(root));
  }
});

test("API CLI forwards preview and confirmation separately and preserves explicit request IDs", async () => {
  const calls: { path: string; body: any; method?: string }[] = [];
  const context = { dataDir: "/unused", output: () => {}, request: async (path: string, init?: RequestInit) => { calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }); } };
  await runConfigGitCli(["commit-preview", "--message", "backup", "--push", "--theme", "dark"], context);
  assert.deepEqual(calls[0], { path: "/api/config-git/commit-preview", method: "POST", body: { message: "backup", push: true, regenerate: false, theme: "dark" } });
  await runConfigGitCli(["commit", "--token", "preview", "--request-id", "retry-id"], context);
  assert.deepEqual(calls[1].body, { token: "preview", requestId: "retry-id" });
  await runConfigGitCli(["restore-preview", "--sha", "abc", "--categories", "general,webBridge"], context);
  assert.deepEqual(calls[2].body, { source: { kind: "git", sha: "abc" }, categories: ["general", "webBridge"], mappings: {} });
  await runConfigGitCli(["restore", "--token", "restore-token", "--request-id", "restore-id"], context);
  assert.deepEqual(calls[3].body, { token: "restore-token", requestId: "restore-id" });
  await runConfigGitCli(["export", "--theme", "light"], context);
  assert.deepEqual(calls[4].body, { theme: "light" });
  await runConfigGitCli(["history", "--cursor", "a/b?c"], context);
  assert.equal(calls[5].path, "/api/config-git/commits?cursor=a%2Fb%3Fc");
  await assert.rejects(runConfigGitCli(["restore-preview", "--sha", "abc", "--recovery-point", "id", "--categories", "general"], context));
  await assert.rejects(runConfigGitCli(["commit", "--token"], context));
  await assert.rejects(runConfigGitCli(["export", "--theme", "unknown"], context));
  await assert.rejects(runConfigGitCli(["commit-preview", "--message", "backup", "--pus"], context));
  await assert.rejects(runConfigGitCli(["commit", "--token", "first", "--token", "second"], context));
  assert.equal(calls.length, 6);
  await runConfigGitCli(["bind", "--remote-url", "git@example.com:team/config.git", "--branch", "main", "--name", "Example", "--email", "example@example.com", "--request-id", "binding-id"], context);
  assert.deepEqual(calls[6].body, { remoteUrl: "git@example.com:team/config.git", branch: "main", identity: { name: "Example", email: "example@example.com" }, requestId: "binding-id" });
  await runConfigGitCli(["recover", "--id", "operation/id", "--request-id", "recover-id"], context);
  assert.equal(calls[7].path, "/api/config-git/operations/operation%2Fid/recover");
});
