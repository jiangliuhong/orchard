import test from "node:test";
import assert from "node:assert/strict";
import { validateScript } from "../src/domain/scripts.js";
import { executeScript } from "../src/runtime/script.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const valid = () => ({
  id: "normalize-text", name: "Normalize text", description: "trim text", runtime: "nodejs" as const,
  entryFile: "main.ts", inputSchema: { type: "object" }, outputSchema: { type: "object" }, files: { "main.ts": "export default input => input" },
});

test("script definition accepts a version-local Node.js entry file", () => {
  assert.equal(validateScript(valid()).entryFile, "main.ts");
});

test("script validation rejects path traversal and wrong runtime extensions", () => {
  assert.throws(() => validateScript({ ...valid(), entryFile: "../main.ts", files: { "../main.ts": "x" } }), /入口文件无效/);
  assert.throws(() => validateScript({ ...valid(), runtime: "shell", entryFile: "main.ts", files: { "main.ts": "x" } }), /入口文件无效/);
});

test("script validation rejects a missing entry file and oversized source", () => {
  assert.throws(() => validateScript({ ...valid(), entryFile: "missing.ts" }), /入口文件不存在/);
  assert.throws(() => validateScript({ ...valid(), files: { "main.ts": "x".repeat(1024 * 1024 + 1) } }), /超过 1 MiB/);
});

test("script execution uses the same bounded process protocol for Node.js and Shell", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchard-script-"));
  const node = await executeScript({ runtime: "nodejs", entryFile: "main.ts", files: { "main.ts": "export default value => ({ doubled: value.n * 2 })" }, input: { n: 3 }, cwd, timeoutMs: 5000 });
  assert.deepEqual(node.output, { doubled: 6 });
  const shell = await executeScript({ runtime: "shell", entryFile: "main.sh", files: { "main.sh": "read input; printf '%s' \"$input\"" }, input: { ok: true }, cwd, timeoutMs: 5000 });
  assert.equal((shell.output as { stdout: string }).stdout, JSON.stringify({ ok: true }));
});

test("script execution enforces timeout and output limits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchard-script-"));
  await assert.rejects(executeScript({ runtime: "shell", entryFile: "main.sh", files: { "main.sh": "sleep 2" }, input: {}, cwd, timeoutMs: 20 }), { code: "TIMEOUT" });
  await assert.rejects(executeScript({ runtime: "shell", entryFile: "main.sh", files: { "main.sh": "head -c 100000 /dev/zero" }, input: {}, cwd, timeoutMs: 5000, maxBytes: 1024 }), { code: "OUTPUT_LIMIT" });
});
