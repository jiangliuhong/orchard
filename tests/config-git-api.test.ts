import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { temporary, TestStore } from "./helpers.js";

test("HTTP Git workflow binds, commits, restores and delivers browser preferences through durable operations", async t => {
  const root = temporary(t), bare = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  const store = new TestStore(join(root, "data"));
  const { app } = createApp(store, undefined, undefined, undefined, { testTransport: () => bare });
  t.after(() => app.close()); await app.ready();
  const request = async (path: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: "POST", url: `/api/config-git${path}`, payload: { requestId: randomUUID(), ...payload } });
    assert.ok(response.statusCode < 300, response.body);
    let result = response.json();
    if (response.statusCode === 202) {
      for (let i = 0; i < 300; i++) {
        const operation = await app.inject(result.statusUrl); const status = operation.json();
        if (status.phase === "completed") return status.result;
        assert.ok(!["failed", "recovery_required"].includes(status.phase), JSON.stringify(status));
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("operation timed out");
    }
    return result;
  };
  assert.equal((await app.inject("/api/config-git/repository")).json().binding, null);
  await request("/bind", { remoteUrl: "https://fixture.invalid/config.git", branch: "main", identity: { name: "Fixture", email: "fixture@example.invalid" } });
  const bundle = await request("/export", { theme: "dark" });
  assert.equal(bundle.snapshot.general.theme, "dark");
  const preview = await request("/commit-preview", { theme: "dark", message: "First configuration", push: true, clientId: "browser", preferenceRevision: 0 });
  assert.ok(preview.token); assert.ok(preview.diffs.length);
  const committed = await request("/commit", { token: preview.token, theme: "dark", clientId: "browser", preferenceRevision: 0 });
  assert.equal(committed.pushed, true);
  const history = (await app.inject("/api/config-git/commits?source=remote")).json();
  assert.equal(history.items[0].sha, committed.sha);
  await request("/export", { theme: "light" });
  const plan = await request("/restore-preview", { source: { kind: "git", sha: committed.sha }, categories: ["general"], clientId: "browser", preferenceRevision: 1, theme: "light" });
  const restored = await request("/restore", { token: plan.token });
  assert.equal(restored.phase, "completed");
  assert.equal((await app.inject("/api/config-git/general/pending?clientId=other")).json().items.length, 0);
  const pending = (await app.inject("/api/config-git/general/pending?clientId=browser")).json().items[0];
  assert.equal(pending.theme, "dark");
  const mismatch = await app.inject({ method: "POST", url: "/api/config-git/general/ack", payload: { clientId: "browser", operationId: pending.operationId, preferenceRevision: 2, decision: "apply" } });
  assert.equal(mismatch.statusCode, 409);
  await request("/general/ack", { clientId: "browser", operationId: pending.operationId, preferenceRevision: 2, decision: "keep" });
  assert.equal((await app.inject("/api/config-git/general/pending?clientId=browser")).json().items.length, 0);
  const claim = await request("/general/claim", { clientId: "new-browser", preferenceRevision: 0 });
  assert.equal(claim.requiresConfirmation, true);
  assert.equal((await app.inject("/api/config-git/recovery-points")).json().items.length, 1);
});
