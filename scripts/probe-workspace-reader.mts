// No prompts, model calls, auth or existing session/config reads.
// node --import tsx scripts/probe-workspace-reader.mts --pi-package /absolute/pi-package
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ScopedWorkspaceReader } from "../src/agent/workspace-files.js";
const index = process.argv.indexOf("--pi-package"), root = process.argv[index + 1];
assert.ok(index > 0 && typeof root === "string" && isAbsolute(root), "Supply --pi-package with an absolute installed package root");
const scratch = mkdtempSync(join(tmpdir(), "orchard-read-boundary-")), cwd = join(scratch, "workspace"); mkdirSync(cwd);
try {
  const files = { "visible.txt": "PLATFORM_VISIBLE\nsecond line" };
  writeFileSync(join(cwd, "unregistered.txt"), "UNREGISTERED_HOST_FILE");
  const outside = join(scratch, "outside.txt"); writeFileSync(outside, "OUTSIDE_HOST_FILE");
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const { createReadTool } = await import(pathToFileURL(join(root, "dist/core/tools/read.js")).href);
  const reader = new ScopedWorkspaceReader(cwd, files);
  const tool = createReadTool(cwd, { operations: reader.nativeReadOperations() });
  const result = await tool.execute("visible", { path: "visible.txt" });
  assert.match(JSON.stringify(result), /PLATFORM_VISIBLE/);
  for (const path of [outside, "../outside.txt", "unregistered.txt"]) await assert.rejects(() => tool.execute("denied", { path }));
  reader.revoke(); await assert.rejects(() => tool.execute("released", { path: "visible.txt" }));
  console.log(JSON.stringify({ packageVersion, installedNativeReadWithScopedOperations: true, outsideAbsoluteDenied: true, traversalDenied: true, unregisteredFileDenied: true, revokedLeaseDenied: true,
    limits: "Tests the installed read tool implementation, not RPC extension loading, MCP coexistence or model tool selection" }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
