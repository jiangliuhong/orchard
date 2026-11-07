import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigOperations } from "../src/config-git/operations.js";
import { temporary, until } from "./helpers.js";
import { readJson, safe, writeJson } from "../src/migrations/journal.js";

test("config operations keep request identity and final outcome across service restart", async t => {
  const root = temporary(t), operations = new ConfigOperations(root);
  let calls = 0;
  const first = operations.start("push", "request", { branch: "main" }, async () => { calls++; return { sha: "a" }; });
  assert.equal(operations.start("push", "request", { branch: "main" }, () => { calls++; }).operationId, first.operationId);
  assert.throws(() => operations.start("push", "request", { branch: "other" }, () => {}), { code: "REQUEST_CONFLICT" });
  await until(() => operations.get(first.operationId).phase === "completed");
  assert.equal(calls, 1); await operations.close();
  const reopened = new ConfigOperations(root);
  assert.equal(reopened.start("push", "request", { branch: "main" }, () => { throw new Error("must not run"); }).operationId, first.operationId);
  assert.deepEqual(reopened.get(first.operationId).result, { sha: "a" }); await reopened.close();
});

test("interrupted operations retry the same identity, errors do not leak raw secrets", async t => {
  const root = temporary(t), operations = new ConfigOperations(root);
  const accepted = operations.start("push", "request", {}, () => { throw new Error("token=secret"); });
  await until(() => operations.get(accepted.operationId).phase === "failed"); await operations.close();
  assert.doesNotMatch(JSON.stringify(operations.get(accepted.operationId)), /token=secret/);
  const path = safe(root, `config-git/api-operations/${accepted.operationId}.json`), record = readJson<Record<string, unknown>>(path);
  record.phase = "running"; writeJson(path, record);
  const reopened = new ConfigOperations(root);
  assert.equal(reopened.get(accepted.operationId).phase, "interrupted");
  assert.equal(reopened.start("push", "request", {}, () => ({ confirmed: true })).operationId, accepted.operationId);
  await until(() => reopened.get(accepted.operationId).phase === "completed"); await reopened.close();
});
