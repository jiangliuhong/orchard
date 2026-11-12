// Non-generative protocol probe. No prompt/turn/start, credentials or existing sessions.
// Usage: node scripts/probe-workspace-cli.mjs --pi /absolute/pi --pi-package /absolute/package --codex /absolute/codex
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
for (const key of ["--pi", "--pi-package", "--codex"]) assert.ok(isAbsolute(options.get(key) ?? ""), `${key} must be an absolute path`);
const root = mkdtempSync(join(tmpdir(), "orchard-workspace-cli-probe-"));
const home = join(root, "home"), cwd = join(root, "workspace"), agentDir = join(root, "pi-config");
for (const dir of [home, cwd, agentDir]) mkdirSync(dir, { mode: 0o700 });
// Deliberately do not inherit model credentials, user configuration or plugin settings.
const env = { PATH: process.env.PATH ?? "", HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", CODEX_HOME: join(root, "codex-home") };
const digest = text => createHash("sha256").update(text).digest("hex");
const run = (executable, args) => {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};

async function rpcState(args) {
  const child = spawn(options.get("--pi"), args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostic = "", bytes = 0;
  const decoder = new StringDecoder("utf8");
  child.stdin.on("error", () => {}); // Early CLI exit is diagnosed through closed.
  const records = [], pending = new Map();
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  void closed.catch(() => {});
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { child.kill("SIGKILL"); return; }
    output += decoder.write(chunk);
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      try {
        const record = JSON.parse(line); records.push(record);
        if (record.type === "response" && pending.has(record.id)) { pending.get(record.id)(record); pending.delete(record.id); }
      } catch { child.kill("SIGKILL"); }
    }
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  const request = async type => {
    const id = randomUUID();
    const response = new Promise(resolve => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ id, type })}\n`);
    const result = await Promise.race([response, closed.then(() => { throw new Error(`Pi exited before ${type}: ${diagnostic}`); })]);
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  try {
    const state = await request("get_state");
    await request("clear_queue"); await request("abort");
    child.stdin.end();
    const exit = await closed;
    assert.equal(exit.code, 0, diagnostic);
    assert.equal(records.some(record => record.type === "agent_start" || record.type === "message_start"), false);
    return { sessionId: state.sessionId, sessionFilePresent: typeof state.sessionFile === "string", isStreaming: state.isStreaming,
      eofExitCode: exit.code, modelRunObserved: false };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
  }
}

try {
  const piVersion = run(options.get("--pi"), ["--version"]).trim();
  const packageVersion = JSON.parse(readFileSync(join(options.get("--pi-package"), "package.json"), "utf8")).version;
  assert.equal(packageVersion, piVersion, "The read tool package must match the probed CLI version");
  const piHelp = run(options.get("--pi"), ["--help"]);
  const codexVersion = run(options.get("--codex"), ["--version"]).trim();
  const protocolRoot = join(root, "protocol");
  run(options.get("--codex"), ["app-server", "generate-ts", "--experimental", "--out", protocolRoot]);
  const protocol = Object.fromEntries(["ThreadStartParams", "ThreadResumeParams", "DynamicToolSpec", "SandboxPolicy"].map(name => {
    const content = readFileSync(join(protocolRoot, "v2", `${name}.ts`), "utf8");
    return [name, { sha256: digest(content), relevantLines: content.split("\n").filter(line => /dynamicTools|sandbox\??:|runtimeWorkspaceRoots\??:|threadId:|readOnly|inputSchema|name:/.test(line)).map(line => line.trim()) }];
  }));
  const common = ["--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--tools", "read,grep,find,ls"];
  const ephemeral = await rpcState([...common, "--no-session"]);
  const ephemeralHistoryFiles = readdirSync(root, { recursive: true }).filter(path => String(path).endsWith(".jsonl")).length;
  assert.equal(ephemeralHistoryFiles, 0);
  const namedId = randomUUID(), sessions = join(root, "sessions"); mkdirSync(sessions);
  const named = await rpcState([...common, "--session-dir", sessions, "--session-id", namedId]);
  assert.equal(named.sessionId, namedId);
  const sessionFiles = readdirSync(sessions).length;
  // Use the installed native tool implementation, not a mock. Only read synthetic
  // markers in this probe's own directory; never inspect host credentials/files.
  const { createReadTool } = await import(pathToFileURL(join(options.get("--pi-package"), "dist/core/tools/read.js")).href);
  writeFileSync(join(cwd, "inside.txt"), "ORCHARD_INSIDE_MARKER");
  const outside = join(root, "outside.txt"); writeFileSync(outside, "ORCHARD_OUTSIDE_MARKER");
  const read = createReadTool(cwd);
  const inside = await read.execute("probe-inside", { path: "inside.txt" });
  const absolute = await read.execute("probe-absolute", { path: outside });
  const traversal = await read.execute("probe-traversal", { path: "../outside.txt" });
  assert.ok(JSON.stringify(inside).includes("ORCHARD_INSIDE_MARKER"));
  assert.ok(JSON.stringify(absolute).includes("ORCHARD_OUTSIDE_MARKER"));
  assert.ok(JSON.stringify(traversal).includes("ORCHARD_OUTSIDE_MARKER"));
  console.log(JSON.stringify({ probeVersion: 1, piVersion, codexVersion, piHelpSha256: digest(piHelp),
    piFlags: common, ephemeral: { ...ephemeral, storedHistoryFiles: ephemeralHistoryFiles }, named: { ...named, explicitSessionIdMatched: named.sessionId === namedId, filesAfterNoTurn: sessionFiles },
    nativeRead: { insideRead: true, absoluteOutsideRead: true, traversalOutsideRead: true, cwdIsSandbox: false },
    codexProtocol: protocol,
    limits: ["No model generation or model tool dispatch tested", "No real session resume after a generated turn tested", "No Orchard MCP authentication/application tested", "Codex generated types only; no sandbox execution tested"] }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
