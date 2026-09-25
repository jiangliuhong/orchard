import assert from "node:assert/strict";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
