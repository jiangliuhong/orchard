import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PassThrough, Readable } from "node:stream";
import { connect, createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { spawn as spawnProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, realpathSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setup, prepareMaintenanceFixture } from "./helpers.js";
import { AppError } from "../src/domain/errors.js";
import { canonicalJson, digest } from "../src/persistence/files.js";
import { MaintenanceAssets } from "../src/agent/maintenance-assets.js";
import { MaintenanceService, type MaintenanceBoundary } from "../src/agent/maintenance-service.js";
import { MaintenanceToolGateway } from "../src/agent/maintenance-tools.js";
import { ScopedWorkspaceReader } from "../src/agent/workspace-files.js";
import { installWorkspaceBusinessTracking } from "../src/agent/workspace-business-hooks.js";
import { PrivateMaintenanceBridge } from "../src/agent/maintenance-ipc.js";
import { MaintenanceBridgeClient } from "../src/agent/maintenance-ipc-client.js";
import { MaintenanceMcpClient } from "../src/agent/maintenance-mcp-client.js";
import { MaintenanceProcessRegistry } from "../src/agent/maintenance-processes.js";
import { runMaintenancePiTurn } from "../src/agent/maintenance-pi-backend.js";
import { launchMaintenancePi, launchMaintenancePiSingle } from "../src/agent/maintenance-pi-launcher.js";
import { registerMaintenancePiTools, MAINTENANCE_PI_TOOLS, type MaintenancePiTool } from "../src/agent/maintenance-pi-tools.js";
import { mac, nonce, type BridgeBootstrap, type BridgeRole } from "../src/agent/maintenance-ipc-wire.js";
import { configuredWebBridge } from "../src/web-bridge/configured.js";
import { bridgeDeclaration } from "../src/web-bridge/database-config.js";

const K = "a".repeat(64);
// Real helper probes deliberately do not inherit credentials, NODE_OPTIONS,
// user extension settings or model-provider configuration from the test runner.
const spawn = (executable: string, args: string[], options: SpawnOptions) => spawnProcess(executable, args, { ...options, env: { PATH: process.env.PATH ?? "" } });
async function fixture(t: TestContext) {
  const f = setup(t); t.after(async () => { await f.authoring.close(); f.store.close(); });
  const draft = await f.authoring.create(undefined, "initial"), source = f.store.files.readTree(draft.artifactPath).files;
  const resourceId = JSON.parse(source["workflow.json"]!).id;
  // Explicit test snapshot and DB task, not CLI or installation certification.
  const files = { "project.json": '{"name":"测试 project"}', "docs/readme.md": "alpha\nbeta\nalpha", "AGENTS.md": "Read-only rules" }, hash = digest(canonicalJson(files));
  prepareMaintenanceFixture(f.store);
  const declaration = bridgeDeclaration(readFileSync(f.store.files.path("config/web-bridge.json"), "utf8"));
  f.store.exec("INSERT INTO bridge_configuration VALUES('current',1,?,?,?)", declaration, digest(declaration), Date.now());
  f.store.exec("INSERT INTO agent_workspace_workflow_bindings VALUES(?,?,?)", draft.id, resourceId, Date.now());
  f.store.exec("INSERT INTO agent_workspace_projection_state VALUES('maintenance',1,1,?,?,?,'ready',NULL,?)", K, K, hash, Date.now());
  const target = { kind: "workflow_draft" as const, id: resourceId, scope: { draftId: draft.id } }, assets = new MaintenanceAssets(f.store, configuredWebBridge(f.store), () => f.providers), snapshot = assets.capture(target);
  f.store.exec("INSERT INTO agent_maintenance_sessions(id,actor_key,scenario,owner_kind,owner_id,owner_scope_json,mode,provider_id,model_id,contract_version,tool_policy_version,knowledge_hash,generation,revision,lifecycle,native_delete_state,created_at,updated_at) VALUES('session','local','workflow','workflow_draft',?,?,'multi','test-provider','test-model','orchard.maintenance.v1','readonly',?,1,1,'active','absent',?,?)", resourceId, canonicalJson(target.scope), K, Date.now(), Date.now());
  f.store.exec("INSERT INTO agent_maintenance_tasks(id,session_id,mode,request_id,request_hash,sequence,generation,projection_generation,projection_hash,baseline_json,status,process_state,created_at) VALUES('task','session','multi','turn',?,1,1,1,?,?,'running','running',?)", K, hash, canonicalJson(snapshot.baseline), Date.now());
  t.after(installWorkspaceBusinessTracking(f.store));
  let allowed = true;
  const boundary: MaintenanceBoundary = { authorize() { if (!allowed) throw new AppError("FORBIDDEN", "PRIVATE_CREDENTIAL_MARKER", 403); }, knownSecrets: () => ["PRIVATE_CREDENTIAL_MARKER"], assertQuiescent() {}, async synchronize() {} };
  const service = new MaintenanceService(f.store, assets, boundary), gateway = new MaintenanceToolGateway(f.store, service);
  const reader = new ScopedWorkspaceReader(resolve(f.root, "agent/workspace"), files), controller = new AbortController();
  const bridge = await PrivateMaintenanceBridge.open({ reader, gateway, actor: "local", sessionId: "session", taskId: "task", signal: controller.signal });
  t.after(() => bridge.close());
  const input = { contractVersion: "orchard.maintenance.v1", requestId: "submit", summary: "Candidate", target, baseline: snapshot.baseline,
    change: { operation: "replace", files: Object.fromEntries(Object.entries(source).filter(([path]) => path !== "layout.json")) } };
  return { ...f, draft, reader, bridge, controller, gateway, assets, boundary, input, deny() { allowed = false; } };
}
async function bootstrap(bridge: PrivateMaintenanceBridge, role: BridgeRole): Promise<BridgeBootstrap> {
  const pipe = new PassThrough(), parts: Buffer[] = []; pipe.on("data", part => parts.push(part));
  await bridge.writePrivateBootstrap(role, pipe); return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
const client = (info: BridgeBootstrap) => MaintenanceBridgeClient.fromPrivateBootstrap(Readable.from([JSON.stringify(info)]));
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
async function raw(info: BridgeBootstrap): Promise<Socket> { const socket = connect({ host: info.host, port: info.port }); socket.on("error", () => {}); await once(socket, "connect"); return socket; }

test("real IPC serves bounded snapshot reads and MCP on separate authenticated roles without public credentials", async t => {
  const f = await fixture(t), readerInfo = await bootstrap(f.bridge, "reader"), read = await client(readerInfo), mcp = await client(await bootstrap(f.bridge, "mcp"));
  try {
    assert.equal(JSON.stringify(f.bridge), "{}"); assert.equal(JSON.stringify(read), "{}");
    const result = await read.request("read", { path: "docs/readme.md", offset: 2, limit: 1 }) as { content: string; nextLine: number };
    assert.equal(result.content, "beta"); assert.equal(result.nextLine, 3);
    assert.equal((await read.request("grep", { query: "alpha", limit: 1 }) as any).items.length, 1);
    assert.equal((await read.request("ls", {}) as any).items.length, 3);
    assert.equal((await read.request("find", { pattern: "docs/*" }) as any).items[0], "docs/readme.md");
    assert.ok((await mcp.request("mcp", init) as any).result);
    const tools = await mcp.request("mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
    assert.deepEqual(tools.result.tools.map((tool: any) => tool.name), ["submit_proposal", "apply_proposal", "proposal_status"]);
    await assert.rejects(read.request("mcp", init), { code: "BRIDGE_REQUEST_FAILED" });
    await assert.rejects(mcp.request("read", { path: "project.json" }), { code: "BRIDGE_REQUEST_FAILED" });
    for (const path of ["../workbench.db", "/etc/passwd", "secrets/keyring.json", ".env"]) await assert.rejects(read.request("read", { path }), { code: "BRIDGE_REQUEST_FAILED" });
    for (const name of ["confirm_proposal", "bash", "sql", "write", "read_file"]) {
      const result = await mcp.request("mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }) as any;
      assert.equal(result.result.isError, true);
    }
    const proposed = await mcp.request("mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "submit_proposal", arguments: f.input } }) as any;
    assert.equal(proposed.result.isError, false); assert.equal(f.store.draft(f.draft.id).revision, 0);
    assert.ok(!JSON.stringify(proposed).includes(readerInfo.secret));
  } finally { await f.bridge.close(); await read.close(); await mcp.close(); }
  f.bridge.assertClosed(); assert.throws(() => f.reader.read("project.json"), { code: "WORKSPACE_LEASE_EXPIRED" });
});

test("bad authentication, wrong roles, duplicate connections, malformed UTF-8 and oversized handshakes fail without killing valid peers", async t => {
  const f = await fixture(t), info = await bootstrap(f.bridge, "reader");
  for (const payload of [Buffer.from("x".repeat(5000)), Buffer.from([255, 10]), Buffer.from("GET / HTTP/1.1\r\n"), Buffer.from(JSON.stringify({ version: 1, role: "mcp", nonce: "x".repeat(43), proof: mac(info.secret, "client", "mcp", "x".repeat(43)) }) + "\n")]) {
    const socket = await raw(info), closed = once(socket, "close"); socket.write(payload); await closed;
  }
  const read = await client(info);
  await assert.rejects(client(info), { code: "BRIDGE_BOOTSTRAP_FAILED" });
  assert.ok(await read.request("read", { path: "project.json" }));
  await read.close(); await f.bridge.close(); f.bridge.assertClosed();
});

test("authenticated frame replay and oversized requests close the entire task channel", async t => {
  for (const attack of ["replay", "oversize"]) await t.test(attack, async t => {
    const f = await fixture(t), info = await bootstrap(f.bridge, "reader"), socket = await raw(info), lines = createInterface({ input: socket });
    const next = () => once(lines, "line").then(([line]) => JSON.parse(line));
    const clientNonce = nonce(), authenticated = next();
    socket.write(JSON.stringify({ version: 1, role: "reader", nonce: clientNonce, proof: mac(info.secret, "client", "reader", clientNonce) }) + "\n"); await authenticated;
    const first = next(); socket.write(JSON.stringify({ id: 1, method: "read", params: { path: "project.json" } }) + "\n"); assert.equal((await first).ok, true);
    const closed = once(socket, "close");
    socket.write(attack === "replay" ? JSON.stringify({ id: 1, method: "ls", params: {} }) + "\n" : "x".repeat(5000));
    await closed; lines.close(); await f.bridge.close(); f.bridge.assertClosed(); assert.equal(f.bridge.signal.aborted, true);
  });
});

test("client bounds concurrent requests without losing sequence and reader revocation closes idle channels", async t => {
  const f = await fixture(t), read = await client(await bootstrap(f.bridge, "reader"));
  const requests = Array.from({ length: 8 }, () => read.request("ls", {}));
  await assert.rejects(read.request("ls", {}), { code: "BRIDGE_INPUT_LIMIT" });
  assert.equal((await Promise.all(requests)).length, 8); assert.ok(await read.request("read", { path: "project.json" }));
  f.reader.revoke(); await f.bridge.close(); f.bridge.assertClosed(); await read.close();
});

test("snapshot identity mismatch cannot receive a grant and parent cancellation revokes every authenticated role", async t => {
  const f = await fixture(t);
  await assert.rejects(PrivateMaintenanceBridge.open({ reader: new ScopedWorkspaceReader("/different", { "project.json": "wrong" }), gateway: f.gateway, actor: "local", sessionId: "session", taskId: "task", signal: new AbortController().signal }), { code: "WORKSPACE_LEASE_EXPIRED" });
  const read = await client(await bootstrap(f.bridge, "reader"));
  f.controller.abort(); await f.bridge.close(); f.bridge.assertClosed();
  await assert.rejects(read.request("read", { path: "project.json" })); await read.close();
});

test("every file call rechecks live project permission and revocation never returns native error text", async t => {
  const f = await fixture(t), read = await client(await bootstrap(f.bridge, "reader"));
  f.deny(); await assert.rejects(read.request("read", { path: "project.json" }), error => !String(error).includes("PRIVATE_CREDENTIAL_MARKER"));
  await f.bridge.close(); f.bridge.assertClosed(); await read.close();
});

test("close proof waits for in-flight proposal validation, aborts its commit and does not pretend Provider exit", async t => {
  const f = await fixture(t), mcp = await client(await bootstrap(f.bridge, "mcp")); await mcp.request("mcp", init);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const prepare = f.assets.prepare.bind(f.assets);
  f.assets.prepare = async (...args) => { entered(); await blocked; return prepare(...args); };
  const call = mcp.request("mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_proposal", arguments: f.input } }).catch(() => null);
  await waiting;
  try {
    f.gateway.revokeTask("task"); assert.equal(f.bridge.signal.aborted, true);
    assert.throws(() => f.bridge.assertClosed(), { code: "PROCESS_STOP_UNCONFIRMED" });
  } finally { release(); await f.bridge.close(); await call; await mcp.close(); }
  f.bridge.assertClosed();
  assert.equal(f.store.one("SELECT id FROM agent_maintenance_proposals"), undefined);
  assert.equal(f.store.one("SELECT status FROM agent_maintenance_tasks WHERE id='task'")!.status, "running");
});

test("client authenticates the server before sending requests and neither proof sends the bootstrap secret", async t => {
  const secret = nonce(); let received = "";
  const server = createServer(socket => { socket.on("error", () => {}); socket.on("data", data => { received += data.toString(); socket.write(JSON.stringify({ version: 1, nonce: nonce(), proof: "0".repeat(64) }) + "\n"); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address() as { port: number };
  try { await assert.rejects(client({ version: 1, host: "127.0.0.1", port: address.port, role: "reader", secret }), { code: "BRIDGE_BOOTSTRAP_FAILED" }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.ok(!received.includes(secret)); assert.ok(!received.includes('"method"'));
  await assert.rejects(client({ version: 1, host: "8.8.8.8", port: 80, role: "reader", secret } as any), { code: "BRIDGE_BOOTSTRAP_FAILED" });
});

test("real MCP stdio child separates bootstrap from protocol, ignores notifications and exposes only proposal tools", async t => {
  const f = await fixture(t), child = spawn(process.execPath, ["--import", "tsx", "src/agent/maintenance-mcp-stdio.ts"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const output: Buffer[] = [], errors: Buffer[] = []; child.stdout!.on("data", part => output.push(part)); child.stderr!.on("data", part => errors.push(part));
  const exited = once(child, "exit");
  await f.bridge.writePrivateBootstrap("mcp", child.stdio[3] as any);
  child.stdin!.end([init, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "file:///etc/passwd" } }].map(value => JSON.stringify(value)).join("\n") + "\n");
  const [status] = await exited; assert.equal(status, 0, Buffer.concat(errors).toString());
  const replies = Buffer.concat(output).toString().trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, 3); assert.equal(replies[0].id, 1);
  assert.deepEqual(replies[1].result.tools.map((tool: any) => tool.name), ["submit_proposal", "apply_proposal", "proposal_status"]);
  assert.equal(replies[2].error.code, -32601); assert.ok(!Buffer.concat(output).toString().includes('"secret"'));
  await f.bridge.close(); f.bridge.assertClosed();
});

test("MCP helper exits on IPC loss even while native stdin is still open", async t => {
  const f = await fixture(t), child = spawn(process.execPath, ["--import", "tsx", "src/agent/maintenance-mcp-stdio.ts"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const errors: Buffer[] = []; child.stderr!.on("data", part => errors.push(part)); const exited = once(child, "exit");
  const first = once(child.stdout!, "data"); await f.bridge.writePrivateBootstrap("mcp", child.stdio[3] as any);
  child.stdin!.write(JSON.stringify(init) + "\n"); await first;
  await f.bridge.close(); const [status] = await exited; assert.equal(status, 1);
  assert.equal(Buffer.concat(errors).toString(), "ORCHARD_MAINTENANCE_BRIDGE_FAILED\n"); f.bridge.assertClosed();
});

test("MCP output pipe failure closes IPC and never emits an uncaught native stack", async t => {
  const f = await fixture(t), child = spawn(process.execPath, ["--import", "tsx", "src/agent/maintenance-mcp-stdio.ts"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const errors: Buffer[] = []; child.stderr!.on("data", part => errors.push(part)); const exited = once(child, "exit");
  const outputClosed = once(child.stdout!, "close"); child.stdout!.destroy(); await outputClosed;
  await f.bridge.writePrivateBootstrap("mcp", child.stdio[3] as any); child.stdin!.end(JSON.stringify(init) + "\n");
  const [status] = await exited; assert.equal(status, 1); assert.equal(Buffer.concat(errors).toString(), "ORCHARD_MAINTENANCE_BRIDGE_FAILED\n");
  await f.bridge.close(); f.bridge.assertClosed();
});

test("MCP helper rejects connection arguments and has a fixed credential-free failure diagnostic", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/agent/maintenance-mcp-stdio.ts", "PRIVATE_CREDENTIAL_MARKER"], { stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [], errors: Buffer[] = []; child.stdout!.on("data", part => output.push(part)); child.stderr!.on("data", part => errors.push(part));
  const [status] = await once(child, "exit"); assert.equal(status, 1);
  assert.equal(Buffer.concat(output).toString(), ""); assert.equal(Buffer.concat(errors).toString(), "ORCHARD_MAINTENANCE_BRIDGE_FAILED\n");
});

test("trusted child reads bootstrap from inherited fd 3 and reaches only the task snapshot through real IPC", async t => {
  const f = await fixture(t), moduleUrl = pathToFileURL(resolve("src/agent/maintenance-ipc-client.ts")).href;
  const code = `import {createReadStream} from 'node:fs'; import {MaintenanceBridgeClient} from ${JSON.stringify(moduleUrl)}; const c=await MaintenanceBridgeClient.fromPrivateBootstrap(createReadStream('',{fd:3})); const result=await c.request('read',{path:'project.json'}); process.stdout.write(JSON.stringify(result)); await c.close();`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const output: Buffer[] = [], errors: Buffer[] = []; child.stdout!.on("data", chunk => output.push(chunk)); child.stderr!.on("data", chunk => errors.push(chunk));
  const exited = once(child, "exit"); await f.bridge.writePrivateBootstrap("reader", child.stdio[3] as any);
  const [status] = await exited; assert.equal(status, 0, Buffer.concat(errors).toString());
  assert.equal(JSON.parse(Buffer.concat(output).toString()).content, '{"name":"测试 project"}');
  assert.equal(f.provider.calls.length, 0); await f.bridge.close(); f.bridge.assertClosed();
});

async function piBinding(t: TestContext) {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx", "src/agent/maintenance-mcp-stdio.ts"], { stdio: ["pipe", "pipe", "ignore", "pipe"] });
  const exited = once(child, "exit");
  const mcp = new MaintenanceMcpClient(child.stdout!, child.stdin!);
  t.after(async () => { await mcp.close(); await exited; });
  await f.bridge.writePrivateBootstrap("mcp", child.stdio[3] as any);
  const reader = await client(await bootstrap(f.bridge, "reader"));
  const tools = new Map<string, MaintenancePiTool>(), handlers = new Map<string, (event: any) => any>();
  let active: string[] = [];
  const pi = { registerTool(tool: MaintenancePiTool) { tools.set(tool.name, tool); }, getActiveTools: () => active,
    setActiveTools(names: string[]) { active = names; }, on(name: string, handler: (event: any) => any) { handlers.set(name, handler); } };
  const binding = await registerMaintenancePiTools(pi, { reader, mcp });
  t.after(() => binding.close());
  return { ...f, child, exited, mcp, reader, tools, handlers, pi, binding };
}

test("Pi binding exposes exactly seven tools through real reader IPC and independent MCP stdio helper", async t => {
  const f = await piBinding(t); f.binding.assertReady();
  assert.deepEqual(f.pi.getActiveTools(), MAINTENANCE_PI_TOOLS); assert.equal(f.tools.size, 7);
  assert.equal(JSON.stringify(f.mcp), "{}");
  const invoke = (name: string, params: unknown) => f.tools.get(name)!.execute("call", params);
  const read = await invoke("read", { path: "docs/readme.md", offset: 2, limit: 1 });
  assert.equal(JSON.parse(read.content[0]!.text).content, "beta");
  for (const path of ["/etc/passwd", "../workbench.db", ".env", "secrets/keyring.json"]) await assert.rejects(invoke("read", { path }), { code: "MAINTENANCE_TOOL_FAILED" });
  await assert.rejects(invoke("grep", { query: "alpha", shell: true }), { code: "MAINTENANCE_TOOL_FAILED" });
  const candidate = await invoke("mcp__orchard__submit_proposal", f.input), proposalId = JSON.parse(candidate.content[0]!.text).proposalId;
  await assert.rejects(invoke("mcp__orchard__apply_proposal", { proposalId, requestId: "unconfirmed" }), { code: "MAINTENANCE_TOOL_FAILED" });
  assert.equal(f.store.one("SELECT id FROM agent_maintenance_apply_requests"), undefined);
  assert.equal(f.store.draft(f.draft.id).revision, 0); assert.equal(f.provider.calls.length, 0);
  assert.equal(f.handlers.get("user_bash")!({ command: "touch /tmp/not-allowed" }).result.exitCode, 1);
  assert.equal(f.handlers.get("session_before_switch")!({}).cancel, true);
  assert.equal(f.handlers.get("session_before_fork")!({}).cancel, true);
  assert.equal(f.handlers.get("cache_warming_decision")!({}).action, "stop");
  assert.equal(f.handlers.get("tool_call")!({ toolName: "bash" }).block, true);
  assert.equal(f.handlers.get("input")!({ text: "/skill:external" }).action, "handled");
  f.pi.setActiveTools([...MAINTENANCE_PI_TOOLS, "codemode"]);
  assert.throws(() => f.binding.assertReady(), { code: "MAINTENANCE_TOOL_FAILED" });
  await assert.rejects(invoke("read", { path: "project.json" }), { code: "MAINTENANCE_TOOL_FAILED" });
  await f.binding.close(); await f.exited; await f.bridge.close(); f.bridge.assertClosed();
});

test("Pi tool cancellation closes both private channels and suppresses late proposal commits", async t => {
  const f = await piBinding(t), cancellation = new AbortController();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const prepare = f.assets.prepare.bind(f.assets);
  f.assets.prepare = async (...args) => { entered(); await blocked; return prepare(...args); };
  const call = f.tools.get("mcp__orchard__submit_proposal")!.execute("call", f.input, cancellation.signal);
  const rejected = assert.rejects(call, { code: "MAINTENANCE_TOOL_FAILED" });
  await waiting;
  try { cancellation.abort(); await rejected; assert.throws(() => f.binding.assertReady()); }
  finally { release(); await f.binding.close(); await f.exited; await f.bridge.close(); }
  assert.equal(f.store.one("SELECT id FROM agent_maintenance_proposals"), undefined);
  f.bridge.assertClosed();
});

// Opt-in installed CLI probe, never a release certificate or a model request.
// The extra input driver invokes the real registered adapters directly, NOT an
// LLM tool-call pipeline. Keep it out of every production extension/launcher.
test("installed Pi RPC blocks shell/session switching and executes registered adapters without a model", {
  skip: !process.env.ORCHARD_MAINTENANCE_PI_CLI, timeout: 30000,
}, async t => {
  const f = await fixture(t), home = resolve(f.root, "pi-probe-home"), extension = resolve(home, "probe.mjs");
  await mkdir(home, { recursive: true });
  const extensionEntry = resolve("src/agent/maintenance-pi-extension.ts");
  const bundled = await build({ stdin: { contents: `
    import maintenanceExtension from ${JSON.stringify(extensionEntry)};
    export default function(pi) {
      const tools=new Map();
      maintenanceExtension({
        registerTool(t){tools.set(t.name,t);pi.registerTool(t)},
        getActiveTools:()=>pi.getActiveTools(),
        setActiveTools:n=>pi.setActiveTools(n),
        on(event,handler){pi.on(event,handler)}
      });
      pi.on('session_start',()=>{
        pi.on('input',async(event)=>{
          if(event.text.startsWith('__orchard_probe__')) {
            const q=JSON.parse(event.text.slice('__orchard_probe__'.length));let result;
            try {result=q.name==='loadout'?{active:pi.getActiveTools(),registered:[...tools.keys()]}:await tools.get(q.name).execute('probe',q.args);}
            catch {result={code:'DENIED'};}
            pi.sendMessage({customType:'orchard-probe',content:JSON.stringify(result),display:false});
          }
          return {action:'handled'};
        });
      });
    }`, resolveDir: process.cwd(), sourcefile: "probe.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node24", write: false });
  await writeFile(extension, bundled.outputFiles[0]!.contents);
  const helperEntry = resolve(home, "helper.mjs");
  await build({ entryPoints: [resolve("src/agent/maintenance-mcp-stdio.ts")], bundle: true, platform: "node", format: "esm", target: "node24", outfile: helperEntry });
  const registry = new MaintenanceProcessRegistry(), processBinding = { taskId: "task", sessionId: "session", generation: 1 }, lease = registry.reserve(processBinding);
  t.after(() => registry.close());
  const agentDir = resolve(home, "agent"), workspace = resolve(f.root, "agent/workspace");
  await Promise.all([mkdir(agentDir), mkdir(workspace, { recursive: true })]);
  const entry = (path: string) => ({ path, sha256: digest(readFileSync(path)) });
  const { pi, helper } = await launchMaintenancePiSingle({
    registry, lease, bridge: f.bridge, pi: entry(realpathSync(process.env.ORCHARD_MAINTENANCE_PI_CLI!)),
    extension: entry(extension), helper: entry(helperEntry), workspace, privateHome: home, agentDir,
  });
  const piExited = pi.exited, helperExited = helper.exited;
  const lines = createInterface({ input: pi.stdout! }), pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  let sequence = 0, diagnostics = ""; pi.stderr!.on("data", value => { if (diagnostics.length < 8000) diagnostics += value.toString(); });
  lines.on("line", line => { const value = JSON.parse(line); if (value.type === "response") { const request = pending.get(value.id); pending.delete(value.id); request?.resolve(value); } });
  void piExited.then(() => { for (const p of pending.values()) p.reject(new Error("Pi exited: " + diagnostics)); pending.clear(); });
  const request = (type: string, args = {}) => registry.track(lease, () => new Promise<any>((resolve, reject) => { const id = String(++sequence); pending.set(id, { resolve, reject }); pi.stdin.write(JSON.stringify({ id, type, ...args }) + "\n"); }));
  t.after(() => lines.close());
  assert.equal((await request("get_state")).success, true, diagnostics);
  const probe = async (name: string, args = {}) => {
    const response = await request("prompt", { message: "__orchard_probe__" + JSON.stringify({ name, args }) });
    assert.equal(response.success, true, diagnostics); assert.equal(response.data.disposition, "handled", diagnostics);
    const messages = (await request("get_messages")).data.messages;
    const result = messages.filter((m: any) => m.customType === "orchard-probe").at(-1);
    assert.ok(result, diagnostics); return JSON.parse(result.content);
  };
  const loadout = await probe("loadout"); assert.deepEqual([...loadout.active].sort(), [...MAINTENANCE_PI_TOOLS].sort()); assert.equal(loadout.registered.length, 7);
  assert.equal((await request("get_commands")).data.commands.length, 0);
  assert.equal((await request("bash", { command: "printf PRIVATE_MARKER" })).data.exitCode, 1);
  assert.equal((await request("new_session")).data.cancelled, true);
  const read = await probe("read", { path: "docs/readme.md", offset: 2, limit: 1 }); assert.equal(JSON.parse(read.content[0].text).content, "beta");
  for (const path of ["/etc/passwd", "../workbench.db", ".env"]) assert.equal((await probe("read", { path })).code, "DENIED");
  const candidate = await probe("mcp__orchard__submit_proposal", f.input); assert.ok(JSON.parse(candidate.content[0].text).proposalId);
  assert.equal(f.store.draft(f.draft.id).revision, 0); assert.equal((await request("get_session_stats")).data.assistantMessages, 0); assert.equal(f.provider.calls.length, 0);
  pi.stdin.end(); await piExited; await helperExited;
  await registry.stop(lease); registry.assertOwnedStopped(lease, processBinding);
  await f.bridge.close(); f.bridge.assertClosed();
});

test("installed Pi dispatches maintenance tools and restores the exact native conversation after both processes exit", {
  skip: !process.env.ORCHARD_MAINTENANCE_PI_CLI, timeout: 30000,
}, async t => {
  const f = await fixture(t);
  const home = resolve(f.root, "pi-dispatch"), agentDir = resolve(home, "agent"), workspace = resolve(f.root, "agent/workspace");
  const directory = resolve(home, "sessions"), sessionId = randomUUID();
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(directory, { recursive: true })]);
  const requests: any[] = [];
  const server = createHttpServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url !== "/v1/chat/completions" || requests.length >= 3) { response.writeHead(404).end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const first = requests.length === 1;
      const calls = [
        { index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "docs/readme.md", offset: 2, limit: 1 }) } },
        { index: 1, id: "call_submit", type: "function", function: { name: "mcp__orchard__submit_proposal", arguments: JSON.stringify(f.input) } },
      ];
      const chunk = { id: "completion", object: "chat.completion.chunk", created: 1, model: "maintenance-test",
        choices: [{ index: 0, delta: first ? { role: "assistant", tool_calls: calls } : { role: "assistant", content: "Proposal submitted." },
          finish_reason: first ? "tool_calls" : "stop" }] };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    } catch { response.writeHead(400).end(); }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  await writeFile(resolve(agentDir, "models.json"), JSON.stringify({ providers: { "orchard-fixture": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "maintenance-test" }, { id: "maintenance-alternate" }],
  } } }), { mode: 0o600 });
  const extension = resolve(home, "extension.mjs"), helperEntry = resolve(home, "helper.mjs");
  await Promise.all([
    build({ entryPoints: ["src/agent/maintenance-pi-extension.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: extension }),
    build({ entryPoints: ["src/agent/maintenance-mcp-stdio.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: helperEntry }),
  ]);
  const registry = new MaintenanceProcessRegistry(), binding = { taskId: "task", sessionId: "session", generation: 1 };
  const lease = registry.reserve(binding); t.after(() => registry.close());
  const entry = (path: string) => ({ path, sha256: digest(readFileSync(path)) });
  const launchOptions = { registry, lease, bridge: f.bridge,
    pi: entry(realpathSync(process.env.ORCHARD_MAINTENANCE_PI_CLI!)), extension: entry(extension), helper: entry(helperEntry),
    workspace, privateHome: home, agentDir, model: "orchard-fixture/maintenance-test",
  };
  const { pi, helper } = await launchMaintenancePi(launchOptions, { directory, id: sessionId });
  const lines = createInterface({ input: pi.stdout });
  t.after(() => lines.close());
  let diagnostics = ""; pi.stderr.on("data", value => { if (diagnostics.length < 8000) diagnostics += value.toString(); });
  const events: any[] = [];
  const settled = new Promise<void>((resolve, reject) => {
    lines.on("line", line => {
      const event = JSON.parse(line); events.push(event);
      if (event.type === "agent_settled") resolve();
      else if (event.type === "response" && !event.success) reject(new Error(JSON.stringify(event)));
    });
    void pi.exited.then(() => reject(new Error(diagnostics)));
  });
  pi.stdin.write(JSON.stringify({ id: "dispatch", type: "prompt", message: "Read the file and submit a proposal." }) + "\n");
  await settled;
  assert.equal(requests.length, 2, diagnostics);
  assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name).sort(), [...MAINTENANCE_PI_TOOLS].sort());
  const toolResults = requests[1].messages.filter((message: any) => message.role === "tool");
  assert.equal(toolResults.length, 2);
  assert.match(JSON.stringify(toolResults.find((message: any) => message.tool_call_id === "call_read")), /beta/);
  assert.match(JSON.stringify(toolResults.find((message: any) => message.tool_call_id === "call_submit")), /proposalId/);
  assert.equal(events.filter(event => event.type === "tool_execution_end" && event.isError === false).length, 2);
  assert.equal(f.store.draft(f.draft.id).revision, 0);
  pi.stdin.end(); await Promise.all([pi.exited, helper.exited]);
  await registry.stop(lease); registry.assertOwnedStopped(lease, binding);
  await f.bridge.close(); f.bridge.assertClosed();
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  const resumeFile = resolve(directory, files[0]!);
  const reader = new ScopedWorkspaceReader(workspace, {
    "project.json": '{"name":"测试 project"}', "docs/readme.md": "alpha\nbeta\nalpha", "AGENTS.md": "Read-only rules",
  });
  const bridge = await PrivateMaintenanceBridge.open({ reader, gateway: f.gateway, actor: "local", sessionId: "session", taskId: "task", signal: f.controller.signal });
  t.after(() => bridge.close());
  const resumeRegistry = new MaintenanceProcessRegistry();
  const resumeLease = resumeRegistry.reserve(binding);
  t.after(() => resumeRegistry.close());
  const resumed = await launchMaintenancePi({ ...launchOptions, registry: resumeRegistry, lease: resumeLease, bridge, model: "orchard-fixture/maintenance-alternate" },
    { directory, id: sessionId, resumeFile });
  const resumeLines = createInterface({ input: resumed.pi.stdout });
  t.after(() => resumeLines.close());
  const command = (type: string, args = {}) => new Promise<any>((resolve, reject) => {
    const onLine = (line: string) => {
      const event = JSON.parse(line);
      if (event.type !== "response" || event.id !== type) return;
      resumeLines.off("line", onLine);
      if (event.success) resolve(event.data); else reject(new Error(JSON.stringify(event)));
    };
    resumeLines.on("line", onLine);
    void resumed.pi.exited.then(() => reject(new Error("Pi exited before " + type)));
    resumed.pi.stdin.write(JSON.stringify({ id: type, type, ...args }) + "\n");
  });
  const state = await command("get_state");
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.sessionFile, resumeFile);
  assert.match(JSON.stringify((await command("get_messages")).messages), /Proposal submitted/);
  resumeLines.close();
  const text = await runMaintenancePiTurn(resumed.pi, "orchard-fixture/maintenance-alternate", "Continue from the previous proposal.",
    new AbortController().signal, { id: sessionId, resumeFile, record: file => assert.equal(file, resumeFile) });
  assert.equal(text, "Proposal submitted.");
  assert.equal(requests.length, 3);
  assert.equal(requests[2].model, "maintenance-alternate");
  assert.match(JSON.stringify(requests[2].messages), /Proposal submitted/);
  assert.match(JSON.stringify(requests[2].messages), /Continue from the previous proposal/);
  resumed.pi.stdin.end();
  await Promise.all([resumed.pi.exited, resumed.helper.exited]);
  await resumeRegistry.stop(resumeLease);
  resumeRegistry.assertOwnedStopped(resumeLease, binding);
  await bridge.close();
  bridge.assertClosed();
});
