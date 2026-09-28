import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegisteredBundle } from "../dist/runtime/artifact-loader.js";
import { executeRegisteredWorkflow } from "../dist/runtime/registered-executor.js";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";

test("artifact store writes private content-addressed JSON and verifies hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-artifacts-"));
  try {
    const store = new ArtifactStore(dir);
    const ref = await store.saveJson({ runId: "run-1", value: { answer: 42 } });
    assert.deepEqual(JSON.parse((await store.read(ref)).toString()), { answer: 42 });
    await assert.rejects(() => store.saveJson({ runId: "run-1", value: "x".repeat(100), maxBytes: 10 }), /exceeds/);
    await assert.rejects(() => store.read({ ...ref, hash: "wrong" }), /hash mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runtime loader validates and imports only the registered bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchard-runtime-artifact-"));
  try {
    const artifactRoot = join(root, "artifacts"); const source = join(artifactRoot, "source"); const bundle = join(artifactRoot, "bundle"); await mkdir(source, { recursive: true }); await mkdir(bundle, { recursive: true });
    const content = "export const answer = 42; export default async (_context, input) => input;"; await writeFile(join(bundle, "worker.mjs"), content); const { createHash } = await import("node:crypto"); const bundleHash = createHash("sha256").update(content).digest("hex");
    await writeFile(join(artifactRoot, "manifest.json"), JSON.stringify({ bundleHash })); const loaded = await loadRegisteredBundle({ instanceRoot: root, artifactPath: "artifacts", manifest: { entry: "bundle/worker.mjs", bundleHash } }); assert.equal(loaded.module.answer, 42); const executed = await executeRegisteredWorkflow(root, { appId: "app", workflowId: "workflow", versionId: "version", artifactPath: "artifacts", manifest: { entry: "bundle/worker.mjs", bundleHash }, input: { ok: true } }, { runId: "run", signal: new AbortController().signal, step: async () => undefined, invokeTool: async () => undefined }); assert.deepEqual(executed, { ok: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact store rejects symlink escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-artifacts-link-"));
  const outside = await mkdtemp(join(tmpdir(), "orchard-outside-"));
  try {
    const store = new ArtifactStore(dir);
    const ref = await store.saveJson({ runId: "run-1", value: { safe: true } });
    await symlink(outside, join(dir, "artifacts", "run-2"));
    await assert.rejects(() => store.saveJson({ runId: "run-2", value: { unsafe: true } }), /escaped/);
    assert.equal(ref.mime, "application/json");
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
