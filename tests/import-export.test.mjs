import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowExport, stageWorkflowExport, validateWorkflowExport } from "../dist/import-export/index.js";

test("workflow export validates digests and stages only safe files", async () => {
  const pkg = await createWorkflowExport({ app: { id: "app" }, workflow: { id: "flow" }, version: { id: "v1", number: 1, manifest: {} }, files: { "source/worker.ts": Buffer.from("export default {}") } });
  assert.equal(validateWorkflowExport(pkg).formatVersion, 1);
  const root = await mkdtemp(join(tmpdir(), "orchard-import-"));
  try { const staging = await stageWorkflowExport(root, pkg); assert.match(staging, /import-v1$/); }
  finally { await rm(root, { recursive: true, force: true }); }
  const tampered = { ...pkg, files: { ...pkg.files, "source/worker.ts": { ...pkg.files["source/worker.ts"], contentBase64: Buffer.from("bad").toString("base64") } } };
  assert.throws(() => validateWorkflowExport(tampered), /digest mismatch/);
  assert.throws(() => validateWorkflowExport({ ...pkg, files: { ...pkg.files, "../escape": pkg.files["source/worker.ts"] } }), /Unsafe relative path/);
});
