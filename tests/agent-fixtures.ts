import { chmodSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporary } from "./helpers.js";

export function installFixture(t: import("node:test").TestContext, name: "codex-server.mjs" | "pi-server.mjs", scenario: string, env: Record<string, string> = {}) {
  const root = temporary(t);
  const executable = join(root, name.replace(".mjs", ""));
  copyFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), executable);
  chmodSync(executable, 0o755);
  const logPath = join(root, "fixture.log");
  process.env[name.startsWith("codex") ? "CODEX_FIXTURE_SCENARIO" : "PI_FIXTURE_SCENARIO"] = scenario;
  process.env[name.startsWith("codex") ? "CODEX_FIXTURE_LOG" : "PI_FIXTURE_LOG"] = logPath;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  t.after(() => { rmSync(logPath, { force: true }); });
  return { executable, logPath, root };
}

export function readLog(path: string) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const pids: number[] = [];
  let argv: string[] = [];
  const records: string[] = [];
  for (const line of lines) {
    if (line.startsWith("pid ")) { pids.push(Number(line.split(" ")[1])); continue; }
    if (line.startsWith("{\"argv\"")) { if (!argv.length) argv = JSON.parse(line).argv as string[]; continue; }
    records.push(line);
  }
  return { pid: pids[0] ?? 0, pids, argv, lines: records };
}
