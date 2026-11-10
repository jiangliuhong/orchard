import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { setup, temporary, until, exampleFiles } from "./helpers.js";
import { gitProjects } from "../src/project-git/service.js";
import { CliProvider } from "../src/providers/registry.js";
import { piNativeAdapter } from "../src/providers/pi-rpc.js";
import { codexNativeAdapter } from "../src/providers/codex-app-server.js";
import { readCodexConfig } from "../src/providers/codex-config.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { AppError } from "../src/domain/errors.js";
import { GraphRunner } from "../src/runtime/runner.js";
import type { SshProfile } from "../src/project-git/types.js";

// Opt-in: starts an isolated local sshd with generated disposable keys, never reads real credentials or pushes.
test("real SSH: clone/fetch, fixed queue revision/SHA, isolated snapshots, workflow output and safe failure", { skip: process.env.ORCHARD_SSH_INTEGRATION !== "1", timeout: 300000 }, async t => {
  const { root, store, provider, providers, authoring } = setup(t);
  const ssh = temporary(t), repo = join(ssh, "repo"); mkdirSync(repo);
  const key = (name: string) => execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(ssh, name)]);
  key("host"); key("client");
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); }); });
  const user = userInfo().username;
  writeFileSync(join(ssh, "sshd_config"), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${ssh}/host\nAuthorizedKeysFile ${ssh}/client.pub\nPidFile ${ssh}/sshd.pid\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\n`);
  // Host key is generated here: use its known public value directly, never trust ssh-keyscan/TOFU.
  writeFileSync(join(ssh, "known_hosts"), `[127.0.0.1]:${port} ${readFileSync(join(ssh, "host.pub"), "utf8").split(" ").slice(0, 2).join(" ")}\n`, { mode: 0o600 });
  const server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(ssh, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = ""; server.stderr.on("data", data => { diagnostic += data; });
  t.after(async () => { server.kill(); await authoring.close(); store.close(); });
  await until(() => diagnostic.includes("Server listening") || server.exitCode !== null, 5000);
  assert.equal(server.exitCode, null, diagnostic);
  const runGit = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).toString().trim();
  runGit("init", "-q", "-b", "main"); runGit("config", "user.name", "Fixture"); runGit("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "left.ts"), "export const left = 11;\n"); writeFileSync(join(repo, "right.ts"), "export const right = 31;\n"); runGit("add", "."); runGit("commit", "-qm", "first");
  const firstSha = runGit("rev-parse", "HEAD"), projects = gitProjects(store);
  const profile: SshProfile = { id: "local", name: "Disposable SSH", host: "127.0.0.1", port, user, identityFile: join(ssh, "client"), knownHostsFile: join(ssh, "known_hosts"), useAgent: false, revision: 1 };
  projects.files.write(["ssh-profiles.json"], [profile]);
  projects.save({ id: "repo", name: "Fixture", remoteUrl: `ssh://${user}@127.0.0.1:${port}${repo}`, branch: "main", sshProfileId: "local", enabled: true, acceptedRiskVersion: 1 });
  const check = projects.check("repo"); await until(() => projects.operation(check.id).status !== "running", 10000); assert.equal(projects.operation(check.id).status, "completed", JSON.stringify(check));
  const snapshot = await projects.prepare(projects.binding("repo"), "run1", "analyze", "attempt1", AbortSignal.timeout(10000), () => {});
  assert.equal(snapshot.source.sha, firstSha); assert.ok(snapshot.workspace.startsWith(root)); assert.ok(snapshot.sessionDirectory.startsWith(root));
  assert.ok(!existsSync(join(snapshot.workspace, ".git"))); writeFileSync(join(snapshot.workspace, "left.ts"), "mutated\n");
  const parallel = await projects.prepare(projects.binding("repo"), "run2", "analyze", "attempt2", AbortSignal.timeout(10000), () => {});
  assert.match(readFileSync(join(parallel.workspace, "left.ts"), "utf8"), /11/); assert.notEqual(snapshot.workspace, parallel.workspace);
  await Promise.all([snapshot.cleanup(), parallel.cleanup()]); assert.ok(!existsSync(snapshot.workspace));
  writeFileSync(join(repo, "left.ts"), "export const left = 12;\n"); runGit("add", "."); runGit("commit", "-qm", "second"); const secondSha = runGit("rev-parse", "HEAD");
  Object.assign(provider, { capabilitiesFor: () => ({ ...provider.capabilities, projectAnalysis: true }) });
  provider.handler = async request => {
    assert.equal(request.executionContext, "project");
    const left = readFileSync(join(request.cwd, "left.ts"), "utf8"), right = readFileSync(join(request.cwd, "right.ts"), "utf8");
    assert.match(left, /12/); assert.match(right, /31/);
    assert.ok(!request.prompt.includes(profile.identityFile)); assert.ok(request.prompt.includes(secondSha));
    return { output: { summary: "43", findings: ["left.ts:1", "right.ts:1"] }, providerId: provider.id, modelId: request.modelId };
  };
  const draft = await authoring.create(undefined, randomUUID());
  const id = JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!).id, files = exampleFiles(id), workflow = JSON.parse(files["workflow.json"]!);
  const node = workflow.nodes.find((n: { type: string }) => n.type === "agent");
  node.input = { source: "workflow" }; node.config.project = { projectId: "repo" }; node.outputSchema = { type: "object", required: ["summary", "findings"], properties: { summary: { type: "string" }, findings: { type: "array", items: { type: "string" } } }, additionalProperties: false };
  workflow.nodes = [node]; workflow.entryNodeId = node.id; workflow.edges = []; workflow.result = { source: "node", nodeId: node.id, pointer: "/summary" }; workflow.outputSchema = { type: "string" };
  files["workflow.json"] = JSON.stringify(workflow); const changed = await authoring.update(draft.id, 0, files), version = (assert.equal(changed.validation.valid, true, JSON.stringify(changed.validation)), await authoring.publish(draft.id, changed.revision, randomUUID()));
  const runner = new GraphRunner(store, providers, undefined, false); t.after(() => runner.close());
  const run = runner.create(version.id, {}, randomUUID());
  // A later disable/revision must not silently swap an already queued project.
  projects.save({ revision: 1, enabled: false, branch: "nonexistent" }, "repo");
  runner.start(); await until(() => !["queued", "running"].includes(store.run(run.id).status), 15000);
  assert.equal(store.run(run.id).status, "succeeded", JSON.stringify(store.run(run.id).error)); assert.equal(store.run(run.id).output, "43");
  const execution = store.attempts(run.id)[0]!.execution as { project: { sha: string; revision: number } };
  assert.equal(execution.project.sha, secondSha); assert.equal(execution.project.revision, 1);
  assert.ok(!existsSync(projects.files.path("runs", `${run.id}.json`)));
  const events = JSON.stringify(store.stream("run", run.id, 0)); assert.ok(!events.includes(profile.identityFile)); assert.ok(!events.includes(ssh));
  const unknown = { ...profile, knownHostsFile: join(ssh, "unknown_hosts") }; writeFileSync(unknown.knownHostsFile, "", { mode: 0o600 });
  await assert.rejects(projects.prepare({ project: { ...projects.list()[0]!, branch: "main" }, profile: unknown }, "bad", "analyze", "attempt", AbortSignal.timeout(10000), () => {}), { code: "SSH_HOST_UNTRUSTED" });
  await assert.rejects(projects.prepare({ project: { ...projects.list()[0]!, branch: "deleted" }, profile }, "missing", "analyze", "attempt", AbortSignal.timeout(10000), () => {}), { code: "PROJECT_BRANCH_NOT_FOUND" });
  // Cancel while fetching/locking: never fall back to a previously cached SHA.
  const cancelled = new AbortController(); cancelled.abort(new AppError("CANCELLED", "test cancellation"));
  await assert.rejects(projects.prepare({ project: { ...projects.list()[0]!, branch: "main" }, profile }, "cancelled", "analyze", "attempt", cancelled.signal, () => {}), { code: "CANCELLED" });
  // Same-project concurrent preparations must serialize cache updates, not share source trees.
  const pair = await Promise.all(["parallel1", "parallel2"].map(id => projects.prepare({ project: { ...projects.list()[0]!, branch: "main" }, profile }, id, "analyze", "attempt", AbortSignal.timeout(10000), () => {})));
  assert.equal(pair[0]!.source.sha, secondSha); assert.equal(pair[1]!.source.sha, secondSha); assert.notEqual(pair[0]!.workspace, pair[1]!.workspace);
  await Promise.all(pair.map(p => p.cleanup()));
  const wrongTrust = join(ssh, "changed_hosts");
  writeFileSync(wrongTrust, `[127.0.0.1]:${port} ${readFileSync(join(ssh, "client.pub"), "utf8").split(" ").slice(0, 2).join(" ")}\n`, { mode: 0o600 });
  await assert.rejects(projects.prepare({ project: { ...projects.list()[0]!, branch: "main" }, profile: { ...profile, knownHostsFile: wrongTrust } }, "changed", "analyze", "attempt", AbortSignal.timeout(10000), () => {}), { code: "SSH_HOST_UNTRUSTED" });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "fixture-passphrase", "-f", join(ssh, "locked")]);
  await assert.rejects(projects.prepare({ project: { ...projects.list()[0]!, branch: "main" }, profile: { ...profile, identityFile: join(ssh, "locked") } }, "locked", "analyze", "attempt", AbortSignal.timeout(10000), () => {}), { code: "SSH_AUTH_FAILED" });
  if (process.env.ORCHARD_MODEL_INTEGRATION === "1") {
    projects.save({ revision: 2, enabled: true, branch: "main", acceptedRiskVersion: 1 }, "repo");
    const manager = new SessionManager(); t.after(() => manager.close());
    for (const id of ["pi-cli", "codex-cli"] as const) {
      const executable = execFileSync("/bin/sh", ["-c", `command -v ${id === "pi-cli" ? "pi" : "codex"}`], { encoding: "utf8" }).trim();
      const modelId = id === "pi-cli" ? process.env.PROBE_PI_MODEL ?? "openai-codex/gpt-6.1-sol" : process.env.PROBE_CODEX_MODEL ?? readCodexConfig().configuredModel!;
      providers.register(new CliProvider(id, { native: id === "pi-cli" ? piNativeAdapter(manager, manager.limits) : codexNativeAdapter(manager, manager.limits) }), executable);
      providers.update(id, { enabled: true, defaultModel: modelId, models: [{ id: modelId, name: modelId, source: "configured", enabled: true }] });
      const config = providers.modelConfigs.create({ name: `Live ${id}`, providerId: id, modelId, requestId: randomUUID() });
      const liveDraft = await authoring.create(undefined, randomUUID()), liveFiles = exampleFiles(JSON.parse(authoring.snapshot(liveDraft.id).files["workflow.json"]!).id);
      const definition = structuredClone(workflow); definition.id = JSON.parse(liveFiles["workflow.json"]!).id;
      definition.nodes[0].config.agentConfigId = config.id;
      definition.nodes[0].config.prompt = "Use tools to read left.ts and right.ts, compute the sum of the two exported numeric constants. Return only JSON: summary is the sum as a string, findings contains left.ts:1 and right.ts:1. Do not access any other files or credentials, install, push, or use the network.";
      definition.nodes.push({ id: "consume", name: "消费结论", type: "code.nodejs", input: { source: "node", nodeId: node.id, pointer: "/summary" }, outputSchema: { type: "string" }, config: { script: "scripts/consume.ts" } });
      definition.edges = [{ id: "consume-result", from: node.id, to: "consume" }];
      definition.result = { source: "node", nodeId: "consume" };
      liveFiles["scripts/consume.ts"] = "export default (input: unknown) => String(input);";
      liveFiles["workflow.json"] = JSON.stringify(definition);
      const liveChanged = await authoring.update(liveDraft.id, 0, liveFiles), liveVersion = await authoring.publish(liveDraft.id, liveChanged.revision, randomUUID());
      const liveRun = runner.create(liveVersion.id, {}, randomUUID());
      await until(() => !["queued", "running"].includes(store.run(liveRun.id).status), 120000);
      assert.equal(store.run(liveRun.id).status, "succeeded", JSON.stringify(store.run(liveRun.id).error));
      assert.equal(store.run(liveRun.id).output, "43");
      const attempt = store.attempts(liveRun.id).find(a => (a.execution as { project?: unknown }).project)!;
      assert.ok((attempt.execution as { toolCallCount: number }).toolCallCount > 0);
      assert.equal((attempt.execution as { project: { sha: string } }).project.sha, secondSha);
    }
  }
  assert.equal(runGit("rev-parse", "HEAD"), secondSha);
  server.kill(); await new Promise(resolve => server.once("exit", resolve));
  await assert.rejects(projects.prepare({ project: { ...projects.list()[0]!, branch: "main" }, profile }, "offline", "analyze", "attempt", AbortSignal.timeout(10000), () => {}), { code: "PROJECT_FETCH_FAILED" });
  await projects.recover();
});
