import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setup, temporary } from "./helpers.js";
import { gitProjects } from "../src/project-git/service.js";
import { ProjectFiles } from "../src/project-git/files.js";
import { normalizeRemote, validateProfile, validateKeyFiles, shellQuote, sshEnvironment, validateBranch, safeGitError } from "../src/project-git/ssh.js";
import { treeEntries, materialize } from "../src/project-git/materialize.js";
import { validateWorkflow } from "../src/domain/validation.js";
import type { SshProfile } from "../src/project-git/types.js";
import { exampleFiles } from "./helpers.js";

export function profileFixture(root: string): SshProfile {
  const keys = join(root, "keys"); mkdirSync(keys, { mode: 0o700 });
  writeFileSync(join(keys, "identity"), "fixture-only-not-a-real-key", { mode: 0o600 });
  writeFileSync(join(keys, "known_hosts"), "fixture-only-not-a-real-host", { mode: 0o600 });
  return { id: "ssh", name: "Test host", host: "example.invalid", port: 2222, user: "git", identityFile: join(keys, "identity"), knownHostsFile: join(keys, "known_hosts"), useAgent: false, revision: 1 };
}

test("SSH parsing, fixed profile identity, branch and option injection validation", t => {
  const profile = profileFixture(temporary(t)); validateProfile(profile); validateKeyFiles(profile);
  assert.equal(normalizeRemote("git@example.invalid:group/repo.git", profile), "git@example.invalid:group/repo.git");
  assert.equal(normalizeRemote("ssh://git@example.invalid:2222/group/repo.git", profile), "ssh://git@example.invalid:2222/group/repo.git");
  for (const remote of ["https://example.invalid/repo", "-oProxyCommand=evil", "git@evil:repo", "git@example.invalid:../secret", "git@example.invalid:x;touch-x", "git@example.invalid:repo\n", "ssh://git@example.invalid:22/repo", "ssh://git@example.invalid:2222/x%3By", "ssh://git:pass@example.invalid:2222/repo"]) assert.throws(() => normalizeRemote(remote, profile), remote);
  for (const branch of ["--upload-pack=x", "x..y", "x@{y", "x.lock", "/x", "x/", "x/.foo", "x y", "x\n", "x:foo"]) assert.throws(() => validateBranch(branch), branch);
  validateBranch("feature/正常-branch");
  chmodSync(profile.identityFile, 0o640); assert.throws(() => validateKeyFiles(profile));
  chmodSync(profile.identityFile, 0o600);
  const alias = join(rootOf(profile), "link"); symlinkSync(profile.identityFile, alias);
  assert.throws(() => validateKeyFiles({ ...profile, identityFile: alias }));
  assert.equal(safeGitError("Host key verification failed").code, "SSH_HOST_UNTRUSTED");
  assert.equal(safeGitError("Permission denied (publickey)").code, "SSH_AUTH_FAILED");
  assert.equal(safeGitError("couldn't find remote ref missing").code, "PROJECT_BRANCH_NOT_FOUND");
});
const rootOf = (profile: SshProfile) => join(profile.identityFile, "..");

test("SSH launcher quotes spaces and apostrophes without command interpolation", t => {
  const root = temporary(t), profile = profileFixture(root), dir = join(root, "transport"); mkdirSync(dir);
  const strange = "quote' $(touch never) spaces";
  const encoded = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(strange)}`], { cwd: root, encoding: "utf8" });
  assert.equal(encoded, strange); assert.ok(!existsSync(join(root, "never")));
  const env = sshEnvironment(dir, profile), launcher = readFileSync(env.GIT_SSH!, "utf8");
  assert.ok(launcher.includes("StrictHostKeyChecking=yes")); assert.ok(launcher.includes("IdentityAgent=none"));
  assert.ok(launcher.endsWith('"$@"\n')); assert.ok(!launcher.includes("StrictHostKeyChecking=no"));
});

test("project revisions, explicit risk, pinned queue configuration and safe profiles", t => {
  const { store, root } = setup(t); t.after(() => store.close());
  const projects = gitProjects(store), profile = profileFixture(root);
  projects.files.write(["ssh-profiles.json"], [profile]);
  const input = { id: "repo", name: "Repo", remoteUrl: "git@example.invalid:group/repo.git", branch: "main", sshProfileId: "ssh", enabled: true };
  assert.throws(() => projects.save(input), { code: "PROJECT_RISK_NOT_ACCEPTED" });
  const created = projects.save({ ...input, acceptedRiskVersion: 1 }); assert.equal(created.revision, 1);
  assert.deepEqual(projects.profileViews(), [{ id: "ssh", name: "Test host", state: "available" }]);
  const workflow = validateWorkflow(JSON.parse(exampleFiles()["workflow.json"]!)); workflow.nodes.find(n => n.type === "agent")!.config.project = { projectId: "repo" };
  projects.pin("queued", workflow);
  projects.save({ revision: 1, branch: "next", enabled: false }, "repo");
  assert.equal(projects.pinned("queued", "b").project.branch, "main");
  assert.equal(projects.pinned("queued", "b").profile.revision, 1);
  assert.throws(() => projects.binding("repo"), { code: "PROJECT_NOT_AVAILABLE" });
  assert.throws(() => projects.save({ revision: 1, name: "stale" }, "repo"), { code: "REVISION_CONFLICT" });
  assert.throws(() => projects.save({ revision: 2, arbitrarySshCommand: "evil" }, "repo"));
  projects.forget("queued"); assert.throws(() => projects.pinned("queued", "b"), { code: "PROJECT_NOT_AVAILABLE" });
});

test("project contract rejects unknown nested fields and unsupported providers before enqueue", t => {
  const { store, root, providers } = setup(t); t.after(() => store.close());
  const workflow = JSON.parse(exampleFiles()["workflow.json"]!);
  workflow.nodes.find((n: { type: string }) => n.type === "agent").config.project = { projectId: "repo", cwd: "/etc" };
  assert.throws(() => validateWorkflow(workflow));
  workflow.nodes.find((n: { type: string }) => n.type === "agent").config.project = { projectId: "repo" };
  assert.throws(() => providers.modelConfigs.resolveWorkflow(validateWorkflow(workflow)), { code: "PROJECT_NOT_AVAILABLE" });
  const projects = gitProjects(store); projects.files.write(["ssh-profiles.json"], [profileFixture(root)]);
  projects.save({ id: "repo", name: "Repo", remoteUrl: "git@example.invalid:repo", branch: "main", sshProfileId: "ssh", enabled: true, acceptedRiskVersion: 1 });
  assert.throws(() => providers.modelConfigs.resolveWorkflow(validateWorkflow(workflow)), { code: "PROJECT_CAPABILITY_UNSUPPORTED" });
});

test("tree path validation rejects traversal, platform aliases, management paths and case collisions", () => {
  const sha = "1".repeat(40), tree = (...names: string[]) => Buffer.from(names.map(name => `100644 blob ${sha}\t${name}\0`).join(""));
  for (const name of ["../escape", "a/../../escape", ".git/config", "a\\b", "/absolute", "file.", "CON.txt", "x:y"]) assert.throws(() => treeEntries(tree(name)), name);
  assert.throws(() => treeEntries(tree("A/file", "a/other")));
  assert.throws(() => treeEntries(tree("é", "é")));
  assert.equal(treeEntries(tree("src/你好.ts"))[0]!.path, "src/你好.ts");
});

test("binary-safe materialization preserves executable files, skips links/submodules and leaves LFS pointers", async t => {
  const root = temporary(t), repo = join(root, "repo"), output = join(root, "output"); mkdirSync(repo); mkdirSync(output);
  const run = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  run("init", "-q"); run("config", "user.name", "Fixture"); run("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "binary"), Buffer.from([0, 1, 128, 255])); writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho test\n", { mode: 0o755 });
  writeFileSync(join(repo, "lfs"), "version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 3\n"); symlinkSync("/outside", join(repo, "link"));
  run("add", "."); run("commit", "-qm", "fixture"); const sha = run("rev-parse", "HEAD").toString().trim();
  run("update-index", "--add", "--cacheinfo", `160000,${sha},module`); run("commit", "-qm", "module");
  const fixed = run("rev-parse", "HEAD").toString().trim();
  const skipped = await materialize(repo, fixed, output, new AbortController().signal);
  assert.deepEqual(skipped, { symlinks: 1, submodules: 1, lfs: 1 });
  assert.deepEqual(readFileSync(join(output, "binary")), Buffer.from([0, 1, 128, 255]));
  assert.ok(!existsSync(join(output, ".git"))); assert.ok(!existsSync(join(output, "link"))); assert.ok(!existsSync(join(output, "module")));
  assert.match(readFileSync(join(output, "run.sh"), "utf8"), /echo test/);
});

test("controlled resource operations reject symlinks and traversal", t => {
  const root = temporary(t), outside = temporary(t), files = new ProjectFiles(root);
  files.directory("cache"); symlinkSync(outside, files.path("cache", "escape"));
  assert.throws(() => files.path("cache", "escape", "file"), { code: "PROJECT_PATH_INVALID" });
  assert.throws(() => files.remove("cache", "escape"), { code: "PROJECT_PATH_INVALID" });
  assert.throws(() => files.path("..", "..", "outside"), { code: "PROJECT_PATH_INVALID" });
  assert.throws(() => files.path("..", "workbench.db"), { code: "PROJECT_PATH_INVALID" });
  assert.deepEqual(readdirSync(outside), []);
});
