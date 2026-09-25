import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileWorkflow } from "../dist/authoring/compiler.js";

test("workflow compiler emits content-addressed ESM bundles inside the output directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchard-compile-"));
  try {
    await writeFile(join(root, "workflow.ts"), "export default { id: 'fixture', run: () => ({ ok: true }) };\n");
    const result = await compileWorkflow({ rootDir: root, entry: "workflow.ts", outputDir: join(root, "versions") });
    assert.equal(result.manifest.contentHash, result.contentHash);
    assert.match(result.bundlePath, new RegExp(`${result.contentHash}\\.mjs$`));
    assert.match(await readFile(result.bundlePath, "utf8"), /ok/);
    await assert.rejects(() => compileWorkflow({ rootDir: root, entry: "../outside.ts", outputDir: join(root, "versions") }), /inside its workspace/);
    await assert.rejects(() => compileWorkflow({ rootDir: root, entry: "workflow.js", outputDir: join(root, "versions") }), /TypeScript file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
