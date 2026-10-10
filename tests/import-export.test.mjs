import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowExport, publishWorkflowImport, stageWorkflowExport, validateWorkflowExport } from "../dist/import-export/index.js";

test("workflow export validates digests and stages only safe files", async () => {
  const pkg = await createWorkflowExport({ app: { id: "app" }, workflow: { id: "flow" }, version: { id: "v1", number: 1, manifest: {} }, files: { "source/worker.ts": Buffer.from("export default {}") } });
  assert.equal(validateWorkflowExport(pkg).formatVersion, 1);
  assert.match(pkg.integrity.fileTreeSha256, /^[a-f0-9]{64}$/);
  const root = await mkdtemp(join(tmpdir(), "orchard-import-"));
  try { const staging = await stageWorkflowExport(root, pkg); assert.match(staging, /import-v1$/); }
  finally { await rm(root, { recursive: true, force: true }); }
  const tampered = { ...pkg, files: { ...pkg.files, "source/worker.ts": { ...pkg.files["source/worker.ts"], contentBase64: Buffer.from("bad").toString("base64") } } };
  assert.throws(() => validateWorkflowExport(tampered), /digest mismatch/);
  assert.throws(() => validateWorkflowExport({ ...pkg, files: { ...pkg.files, "../escape": pkg.files["source/worker.ts"] } }), /Unsafe relative path/);
  assert.throws(() => validateWorkflowExport({ ...pkg, files: { ...pkg.files, "source/worker.ts": { ...pkg.files["source/worker.ts"], contentBase64: "%%%" } } }), /Invalid base64/);
});

test("workflow import moves validated artifacts and preserves them when persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchard-import-publish-"));
  try {
    const pkg = await createWorkflowExport({ app: { id: "app" }, workflow: { id: "flow" }, version: { id: "v1", number: 1, manifest: {} }, files: { "source/worker.ts": Buffer.from("export default {}") } });
    await assert.rejects(() => publishWorkflowImport({ instanceRoot: root, pkg, persist: () => { throw new Error("db failure"); } }), /db failure/);
    const { stat } = await import("node:fs/promises");
    await assert.doesNotReject(() => stat(join(root, "artifacts/app/flow/v1/source/worker.ts")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
