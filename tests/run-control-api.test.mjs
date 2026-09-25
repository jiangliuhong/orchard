import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../dist/server/app.js";

const token = "run-control-token-".repeat(3);
const headers = { host: "127.0.0.1:7331", authorization: `Bearer ${token}` };

test("run detail and cancellation endpoints require storage and preserve cancellation semantics", async (t) => {
  const calls = [];
  const app = createServer({
    accessToken: token,
    authority: headers.host,
    getRun: (id) => id === "run-1" ? { id, workflowVersionId: "version-1", status: "running" } : undefined,
    cancelRun: (id, reason) => { calls.push({ id, reason }); return id === "run-1"; },
  });
  t.after(() => app.close());
  const detail = await app.inject({ url: "/api/runs/run-1", headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().workflowVersionId, "version-1");
  assert.equal((await app.inject({ url: "/api/runs/missing", headers })).statusCode, 404);
  const cancel = await app.inject({ method: "POST", url: "/api/runs/run-1/cancel", headers, payload: { reason: "stop now" } });
  assert.equal(cancel.statusCode, 200);
  assert.deepEqual(calls, [{ id: "run-1", reason: "stop now" }]);
  assert.equal((await app.inject({ method: "POST", url: "/api/runs/missing/cancel", headers, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/runs/run-1/cancel", headers, payload: { reason: "" } })).statusCode, 400);
});
