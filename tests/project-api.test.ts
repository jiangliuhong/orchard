import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, until, exampleFiles } from "./helpers.js";
import { createApp } from "../src/server/app.js";
import { gitProjects } from "../src/project-git/service.js";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import type { PortableSnapshot } from "../src/config-git/snapshot-types.js";

function configure(root: string, projects: ReturnType<typeof gitProjects>) {
  const keys = join(root, "keys"); mkdirSync(keys, { mode: 0o700 });
  for (const name of ["identity", "known_hosts"]) writeFileSync(join(keys, name), "fixture-not-real", { mode: 0o600 });
  projects.files.write(["ssh-profiles.json"], [{ id: "ssh", name: "Test identity", host: "example.invalid", port: 22, user: "git", identityFile: join(keys, "identity"), knownHostsFile: join(keys, "known_hosts"), useAgent: false, revision: 1 }]);
}
const project = { id: "repo", name: "Repository", remoteUrl: "git@example.invalid:repo", branch: "main", sshProfileId: "ssh", enabled: true, acceptedRiskVersion: 1 };

test("project and storage APIs: local protection, risk, revision, no credential paths and shared async scans", async t => {
  const { store, root, providers } = setup(t), projects = gitProjects(store); configure(root, projects);
  const { app } = createApp(store, providers); t.after(() => app.close()); await app.ready();
  const profiles = await app.inject("/api/git-ssh-profiles"); assert.equal(profiles.statusCode, 200);
  assert.deepEqual(profiles.json().items, [{ id: "ssh", name: "Test identity", state: "available" }]); assert.ok(!profiles.body.includes(root));
  const unsafe = await app.inject({ method: "POST", url: "/api/git-projects", headers: { origin: "https://evil.invalid" }, payload: project }); assert.equal(unsafe.statusCode, 403);
  const rejected = await app.inject({ method: "POST", url: "/api/git-projects", payload: { ...project, acceptedRiskVersion: undefined } }); assert.equal(rejected.json().code, "PROJECT_RISK_NOT_ACCEPTED");
  const created = await app.inject({ method: "POST", url: "/api/git-projects", payload: project }); assert.equal(created.statusCode, 200); assert.equal(created.json().revision, 1);
  const changed = await app.inject({ method: "PATCH", url: "/api/git-projects/repo", payload: { revision: 1, enabled: false } }); assert.equal(changed.json().revision, 2);
  const stale = await app.inject({ method: "PATCH", url: "/api/git-projects/repo", payload: { revision: 1, name: "stale" } }); assert.equal(stale.statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/git-projects/repo/check", payload: { sshCommand: "evil" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/storage/usage/scan", payload: { root: "/" } })).statusCode, 400);
  const before = (await app.inject("/api/storage/usage")).json(); assert.equal(before.result, null);
  const first = (await app.inject({ method: "POST", url: "/api/storage/usage/scan", payload: {} })).json();
  const second = (await app.inject({ method: "POST", url: "/api/storage/usage/scan", payload: {} })).json(); assert.equal(first.scanId, second.scanId);
  const completed = await until(async () => { const value = (await app.inject(`/api/storage/usage/scans/${first.scanId}`)).json(); return value.status !== "scanning" && value; });
  assert.equal(completed.status, "completed"); assert.equal(completed.result.dataDir, root);
});

test("synchronous SSH check failures release capacity for subsequent projects", async t => {
  const { store, root } = setup(t);
  t.after(() => store.close());
  const projects = gitProjects(store);
  t.after(() => projects.close());
  projects.files.write(["ssh-profiles.json"], [{ id: "ssh", name: "Missing identity", host: "example.invalid", port: 22, user: "git", identityFile: join(root, "missing-key"), knownHostsFile: join(root, "missing-known-hosts"), useAgent: false, revision: 1 }]);
  for (const id of ["first", "second", "third"]) {
    projects.save({ ...project, id });
    const operation = projects.check(id);
    await until(() => operation.status !== "running");
    assert.equal(operation.status, "failed");
    assert.equal(operation.error?.code, "SSH_AUTH_FAILED");
    assert.ok(operation.completedAt);
  }
});

test("restore preview blocks missing/disabled local project dependencies in drafts and all immutable versions", async t => {
  const { store, root } = setup(t); t.after(() => store.close());
  const projects = gitProjects(store), service = new ConfigRestoreService(store);
  const files = exampleFiles("incoming"), workflow = JSON.parse(files["workflow.json"]!);
  workflow.nodes.find((n: { type: string }) => n.type === "agent").config.project = { projectId: "repo" }; files["workflow.json"] = JSON.stringify(workflow);
  const source: PortableSnapshot = { general: { theme: "system" }, providers: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, scripts: [], workflows: [{ id: "incoming", name: "Incoming", currentPublishedVersionId: null, draft: { baseVersionId: null, files }, versions: [] }] };
  await assert.rejects(service.preview(source, { categories: ["workflows"] }), { code: "PROJECT_NOT_AVAILABLE" });
  configure(root, projects); projects.save(project);
  const preview = await service.preview(source, { categories: ["workflows"] }); assert.ok(preview.token);
  projects.save({ revision: 1, enabled: false }, "repo");
  await assert.rejects(service.apply("stale-project", preview.token), { code: "PREVIEW_EXPIRED" });
  await assert.rejects(service.preview(source, { categories: ["workflows"] }), { code: "PROJECT_NOT_AVAILABLE" });
  source.workflows[0]!.draft = null; source.workflows[0]!.versions = [{ id: "historical-not-current", files }];
  await assert.rejects(service.preview(source, { categories: ["workflows"] }), { code: "PROJECT_NOT_AVAILABLE" });
});

test("project dependency scanning preserves incomplete draft imports without treating nodes as an iterable", async t => {
  const { store } = setup(t); t.after(() => store.close());
  const files = { "workflow.json": JSON.stringify({ id: "incomplete", name: "Incomplete", nodes: {} }), "layout.json": "{}" };
  const source: PortableSnapshot = { general: { theme: "system" }, providers: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, scripts: [], workflows: [{ id: "incomplete", name: "Incomplete", currentPublishedVersionId: null, draft: { baseVersionId: null, files }, versions: [] }] };
  const service = new ConfigRestoreService(store), preview = await service.preview(source, { categories: ["workflows"] });
  assert.ok(preview.token); await service.apply("incomplete", preview.token);
  assert.equal(store.drafts()[0]!.validation.valid, false);
});

test("startup recovery keeps live holders and queued admission snapshots, reclaims only inactive resources", async t => {
  const { store } = setup(t); t.after(() => store.close()); const projects = gitProjects(store); t.after(() => projects.close());
  projects.files.directory("workspaces", "orphan", "node", "attempt"); projects.files.directory("sessions", "orphan", "node", "attempt");
  projects.files.write(["sessions", "orphan", "node", "attempt", "process.json"], { pid: process.pid });
  projects.files.write(["leases", "orphan", "node.json"], { stagingId: "stage", projectId: "repo", nodeId: "node", attemptId: "attempt" });
  projects.files.directory("staging", "stage"); projects.files.directory("workspaces", "stale", "node", "attempt");
  await projects.recover();
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(projects.files.path("workspaces", "orphan"))); assert.ok(!existsSync(projects.files.path("workspaces", "stale")));
  projects.files.remove("sessions", "orphan", "node", "attempt", "process.json"); await projects.recover();
  assert.ok(!existsSync(projects.files.path("workspaces", "orphan"))); assert.ok(!existsSync(projects.files.path("staging", "stage")));
});
