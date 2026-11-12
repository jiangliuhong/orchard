import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { MaintenanceProcessRegistry, type MaintenanceNodeLaunch } from "../src/agent/maintenance-processes.js";
import { MaintenanceStopJournal } from "../src/agent/maintenance-stop-journal.js";

const binding = { taskId: "task", sessionId: "session", generation: 1 };
async function fixture(t: TestContext, code = "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));console.log('ready')") {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "orchard-maintenance-process-")), entry = join(root, "child.mjs");
  await writeFile(entry, code);
  const registry = new MaintenanceProcessRegistry(), lease = registry.reserve(binding);
  t.after(async () => { await registry.close(); await rm(root, { recursive: true, force: true }); });
  const spec: MaintenanceNodeLaunch = { entry, cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, PI_OFFLINE: "1" } };
  return { root, entry, registry, lease, spec };
}
const posix = { skip: process.platform === "win32", timeout: 10000 };

test("restart proof rejects a live recorded process group and an interrupted spawn", posix, async t => {
  const f = await fixture(t);
  const journal = new MaintenanceStopJournal(f.root, () => {});
  const registry = new MaintenanceProcessRegistry(journal);
  t.after(() => registry.close());
  const lease = registry.reserve(binding);
  const child = registry.launch(lease, f.spec);
  await once(child.stdout, "data");
  const restarted = new MaintenanceStopJournal(f.root, () => {});
  assert.throws(() => restarted.assertRestartStopped(binding), { code: "PROCESS_STOP_UNCONFIRMED" });
  await registry.stop(lease);
  restarted.assertRestartStopped(binding);
  registry.forget(lease);
  const interrupted = { ...binding, taskId: "unregistered-spawn" };
  journal.reserve(interrupted);
  journal.beforeSpawn(interrupted);
  assert.throws(() => restarted.assertRestartStopped(interrupted), { code: "PROCESS_STOP_UNCONFIRMED" });
});

test("a new host proves process group exit after the original host is killed", posix, async t => {
  const f = await fixture(t);
  const release = join(f.root, "release");
  await writeFile(f.entry, `
    import { existsSync } from 'node:fs';
    const deadline=Date.now()+5000;
    setInterval(()=>{if(existsSync(${JSON.stringify(release)})||Date.now()>deadline)process.exit(0)},20);
    console.log('ready');
  `);
  const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { once } from 'node:events';
    import { MaintenanceProcessRegistry } from ${JSON.stringify(import.meta.resolve("../src/agent/maintenance-processes.ts"))};
    import { MaintenanceStopJournal } from ${JSON.stringify(import.meta.resolve("../src/agent/maintenance-stop-journal.ts"))};
    const registry=new MaintenanceProcessRegistry(new MaintenanceStopJournal(${JSON.stringify(f.root)},()=>{}));
    const lease=registry.reserve(${JSON.stringify(binding)});
    const child=registry.launch(lease,${JSON.stringify(f.spec)});
    await once(child.stdout,'data');
    console.log('host-ready');
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { host.kill("SIGKILL"); });
  const exited = once(host, "exit");
  const ready = await Promise.race([once(host.stdout!, "data"), exited.then(() => [])]);
  assert.match(String(ready[0]), /host-ready/);
  host.kill("SIGKILL");
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  const replacement = new MaintenanceStopJournal(f.root, () => {});
  assert.throws(() => replacement.assertRestartStopped(binding), { code: "PROCESS_STOP_UNCONFIRMED" });
  await writeFile(release, "");
  const deadline = Date.now() + 3000;
  for (;;) {
    try { replacement.assertRestartStopped(binding); break; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  replacement.remove(binding);
});

test("registry requires an exact host capability and binding, never adopts PID/DB claims", posix, async t => {
  const f = await fixture(t), original = { ...binding };
  assert.equal(JSON.stringify(f.registry), "{}");
  assert.throws(() => f.registry.assertOwnedStopped(f.lease, binding), { code: "PROCESS_STOP_UNCONFIRMED" });
  assert.throws(() => f.registry.stop({ signal: f.lease.signal }), { code: "MAINTENANCE_PROCESS_CAPABILITY_INVALID" });
  const restarted = new MaintenanceProcessRegistry();
  assert.throws(() => restarted.assertOwnedStopped(f.lease, binding), { code: "MAINTENANCE_PROCESS_CAPABILITY_INVALID" });
  await restarted.close(); await f.registry.stop(f.lease); f.registry.assertOwnedStopped(f.lease, original);
  assert.throws(() => f.registry.assertOwnedStopped(f.lease, { ...binding, sessionId: "other" }), { code: "PROCESS_STOP_UNCONFIRMED" });
  assert.throws(() => f.registry.assertOwnedStopped(f.lease, { ...binding, generation: 2 }), { code: "PROCESS_STOP_UNCONFIRMED" });
  assert.throws(() => f.registry.launch(f.lease, f.spec), { code: "MAINTENANCE_PROCESS_BUSY" });
});

test("real Node child receives only the clean environment and EOF stop waits for exit and pipe closure", posix, async t => {
  const f = await fixture(t, "console.log(JSON.stringify(Object.keys(process.env).sort()));process.stdin.resume();process.stdin.on('end',()=>process.exit(0))");
  const coverage = process.env.NODE_V8_COVERAGE, credential = process.env.ORCHARD_TEST_PROCESS_CREDENTIAL;
  process.env.NODE_V8_COVERAGE = join(f.root, "not-allowed-coverage"); process.env.ORCHARD_TEST_PROCESS_CREDENTIAL = "PRIVATE_MARKER";
  let child: ReturnType<typeof f.registry.launch>;
  try { child = f.registry.launch(f.lease, { ...f.spec, privatePipes: 3 }); }
  finally {
    if (coverage === undefined) delete process.env.NODE_V8_COVERAGE; else process.env.NODE_V8_COVERAGE = coverage;
    if (credential === undefined) delete process.env.ORCHARD_TEST_PROCESS_CREDENTIAL; else process.env.ORCHARD_TEST_PROCESS_CREDENTIAL = credential;
  }
  const [data] = await once(child.stdout, "data"), keys: string[] = JSON.parse(data.toString());
  // macOS CoreFoundation may synthesize this system encoding variable at exec;
  // it is not an inherited provider key or user-supplied runtime configuration.
  const allowed = new Set([...Object.keys(f.spec.env), ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [])]);
  assert.ok(keys.every(key => allowed.has(key)), JSON.stringify(keys));
  assert.ok(!keys.includes("NODE_V8_COVERAGE")); assert.ok(!keys.includes("ORCHARD_TEST_PROCESS_CREDENTIAL"));
  assert.equal(child.privatePipes.length, 3);
  assert.throws(() => f.registry.assertOwnedStopped(f.lease, binding), { code: "PROCESS_STOP_UNCONFIRMED" });
  const stopping = f.registry.stop(f.lease, { eofMs: 1000 });
  assert.equal(f.lease.signal.aborted, true); assert.equal(f.registry.stop(f.lease), stopping);
  await stopping; await child.exited; f.registry.assertOwnedStopped(f.lease, binding);
  f.registry.forget(f.lease);
  assert.throws(() => f.registry.assertOwnedStopped(f.lease, binding), { code: "MAINTENANCE_PROCESS_CAPABILITY_INVALID" });
});

test("SIGTERM handles a child that does not stop at stdin EOF", posix, async t => {
  const f = await fixture(t, "process.stdin.resume();setInterval(()=>{},1000);process.on('SIGTERM',()=>{process.stdout.write('terminated');process.exit(0)});console.log('ready')");
  const child = f.registry.launch(f.lease, f.spec); await once(child.stdout, "data");
  let output = ""; child.stdout.on("data", chunk => { output += chunk.toString(); });
  await f.registry.stop(f.lease, { eofMs: 10, terminateMs: 1000 });
  assert.match(output, /terminated/); f.registry.assertOwnedStopped(f.lease, binding);
});

test("SIGKILL escalation waits for actual exit when SIGTERM is ignored", posix, async t => {
  const f = await fixture(t, "process.stdin.resume();setInterval(()=>{},1000);process.on('SIGTERM',()=>console.log('ignored'));console.log('ready')");
  const child = f.registry.launch(f.lease, f.spec); await once(child.stdout, "data");
  let output = ""; child.stdout.on("data", chunk => { output += chunk.toString(); });
  await f.registry.stop(f.lease, { eofMs: 10, terminateMs: 50, killMs: 1000 });
  assert.match(output, /ignored/); f.registry.assertOwnedStopped(f.lease, binding);
});

test("one lease owns independent Provider/helper groups and keeps project admission serialized", posix, async t => {
  const f = await fixture(t);
  const children = [f.registry.launch(f.lease, f.spec), f.registry.launch(f.lease, f.spec)];
  await Promise.all(children.map(child => once(child.stdout, "data")));
  assert.throws(() => f.registry.reserve({ ...binding, taskId: "next" }), { code: "MAINTENANCE_PROCESS_BUSY" });
  await f.registry.stop(f.lease, { eofMs: 1000 }); f.registry.assertOwnedStopped(f.lease, binding);
  const next = f.registry.reserve({ ...binding, taskId: "next" }); await f.registry.stop(next);
  assert.throws(() => f.registry.reserve(binding), { code: "MAINTENANCE_PROCESS_BUSY" });
  f.registry.forget(f.lease); f.registry.forget(next);
});

test("timed-out callbacks stay blocking after process exit; a retry needs their real settlement", posix, async t => {
  const f = await fixture(t), child = f.registry.launch(f.lease, f.spec); await once(child.stdout, "data");
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const work = f.registry.track(f.lease, () => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  await waiting;
  try {
    await assert.rejects(f.registry.stop(f.lease, { eofMs: 30, terminateMs: 30, killMs: 30 }), { code: "PROCESS_STOP_UNCONFIRMED" });
    assert.throws(() => f.registry.assertOwnedStopped(f.lease, binding), { code: "PROCESS_STOP_UNCONFIRMED" });
    assert.throws(() => f.registry.track(f.lease, async () => {}), { code: "MAINTENANCE_PROCESS_BUSY" });
    assert.throws(() => f.registry.reserve({ ...binding, taskId: "next" }), { code: "MAINTENANCE_PROCESS_BUSY" });
  } finally { release(); await work; }
  await f.registry.stop(f.lease, { eofMs: 1000 }); f.registry.assertOwnedStopped(f.lease, binding);
});

test("close revokes work queued before its factory runs and is idempotent", posix, async t => {
  const f = await fixture(t); let invoked = false;
  const work = f.registry.track(f.lease, async () => { invoked = true; });
  const rejected = assert.rejects(work, { name: "AbortError" });
  const first = f.registry.close(); assert.equal(f.registry.close(), first);
  await rejected; await first; assert.equal(invoked, false);
  f.registry.assertOwnedStopped(f.lease, binding);
  assert.throws(() => f.registry.reserve({ ...binding, taskId: "next" }), { code: "MAINTENANCE_PROCESS_BUSY" });
});

test("pre-spawn failures wait for native close; invalid launch/environment never starts a process", posix, async t => {
  const f = await fixture(t);
  for (const extra of [{ entry: "relative.js" }, { entry: "/bin/sh" }, { cwd: "relative" }, { privatePipes: 4 }, { env: { NODE_OPTIONS: "--import PRIVATE_MARKER" } }, { args: ["\0"] }]) {
    assert.throws(() => f.registry.launch(f.lease, { ...f.spec, ...extra } as MaintenanceNodeLaunch), { code: "MAINTENANCE_PROCESS_LAUNCH_INVALID" });
  }
  const child = f.registry.launch(f.lease, { ...f.spec, cwd: join(f.root, "missing") }); await child.exited;
  await f.registry.stop(f.lease, { eofMs: 1000 }); f.registry.assertOwnedStopped(f.lease, binding);
  f.registry.forget(f.lease);
  const nextBinding = { ...binding, taskId: "cancel-before-spawn" }, next = f.registry.reserve(nextBinding);
  f.registry.launch(next, f.spec);
  // Neither initial signal phase sees a spawned leader. The late spawn handler
  // still terminates the child rather than leaving it alive after cancellation.
  await f.registry.stop(next, { eofMs: 0, terminateMs: 0, killMs: 1000 });
  f.registry.assertOwnedStopped(next, nextBinding);
});

test("abort listeners can reenter stop and close without duplicating shutdown promises", posix, async t => {
  const f = await fixture(t); let reenteredStop!: Promise<void>;
  f.lease.signal.addEventListener("abort", () => { reenteredStop = f.registry.stop(f.lease); }, { once: true });
  const stopped = f.registry.stop(f.lease); assert.equal(reenteredStop, stopped); await stopped;
  f.registry.forget(f.lease);
  const next = f.registry.reserve({ ...binding, taskId: "next" }); let reenteredClose!: Promise<void>;
  next.signal.addEventListener("abort", () => { reenteredClose = f.registry.close(); }, { once: true });
  const closed = f.registry.close(); assert.equal(reenteredClose, closed); await closed;
});

test("registered rejecting callbacks drain without disguising failure as an outstanding process", posix, async t => {
  const f = await fixture(t);
  await assert.rejects(f.registry.track(f.lease, async () => { throw new Error("test failure"); }), /test failure/);
  await f.registry.close(); f.registry.assertOwnedStopped(f.lease, binding);
});

test("group stop includes an ordinary descendant while its live leader remains owned", posix, async t => {
  const f = await fixture(t, `
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdin.resume();let stopping=false;
    process.on('SIGTERM',()=>{stopping=true;child.kill('SIGTERM')});
    child.once('exit',()=>{if(stopping)process.exit(0)});
    child.once('spawn',()=>console.log('ready'));
  `);
  const child = f.registry.launch(f.lease, f.spec); await once(child.stdout, "data");
  await f.registry.stop(f.lease, { eofMs: 10, terminateMs: 1000 }); f.registry.assertOwnedStopped(f.lease, binding);
});

test("exited leader with a surviving group stays unconfirmed; registry never guesses a cleanup PID", {
  skip: process.platform !== "darwin", timeout: 10000,
}, async t => {
  // macOS reaps the deliberately orphaned fixture. Minimal Linux container init
  // implementations may retain its zombie indefinitely; that must remain blocked,
  // not be weakened to make this cleanup-oriented probe pass on those hosts.
  const f = await fixture(t, `
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),2000)'],{stdio:'ignore'});
    child.once('spawn',()=>process.stdout.write(String(child.pid)+'\\n',()=>process.exit(0)));
  `);
  const child = f.registry.launch(f.lease, f.spec), [data] = await once(child.stdout, "data"), descendant = Number(data.toString().trim());
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  await child.exited; await new Promise(resolve => setTimeout(resolve, 20));
  try {
    await assert.rejects(f.registry.stop(f.lease, { eofMs: 10, terminateMs: 10, killMs: 10 }), { code: "PROCESS_STOP_UNCONFIRMED" });
    assert.doesNotThrow(() => process.kill(descendant, 0));
    assert.throws(() => f.registry.assertOwnedStopped(f.lease, binding), { code: "PROCESS_STOP_UNCONFIRMED" });
    assert.throws(() => f.registry.reserve({ ...binding, taskId: "next" }), { code: "MAINTENANCE_PROCESS_BUSY" });
  } finally {
    // Only the TEST owns this fixture's independently reported child reference.
    // No registry adoption/recovery/production kill-by-PID path is introduced.
    try { process.kill(descendant, "SIGTERM"); } catch { /* Fixture already ended. */ }
    await f.registry.stop(f.lease, { eofMs: 1000 });
  }
  f.registry.assertOwnedStopped(f.lease, binding);
});
