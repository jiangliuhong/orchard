import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../dist/server/app.js";

const token = "event-api-token-".repeat(3);
const headers = { host: "127.0.0.1:7331", authorization: `Bearer ${token}` };

test("event API validates, authenticates and preserves idempotent intake result", async (t) => {
  const received = [];
  const app = createServer({ accessToken: token, authority: headers.host, receiveEvent: (event) => {
    received.push(event);
    return { id: "event-record", duplicate: received.length > 1 };
  } });
  t.after(() => app.close());
  const body = { source: "test", id: "1", name: "fixture.created", data: { ok: true } };
  const first = await app.inject({ method: "POST", url: "/api/events", headers, payload: body });
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json(), { eventId: "event-record", duplicate: false });
  const second = await app.inject({ method: "POST", url: "/api/events", headers, payload: body });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().duplicate, true);
  assert.equal(received.length, 2);
  for (const payload of [{ source: "x" }, { source: "x", id: "1", name: "n" }, { source: "x", id: "1", name: "n", data: {} , extra: true }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/events", headers, payload })).statusCode, 400);
  }
});

test("runs endpoint uses stable pagination and hides storage errors", async (t) => {
  const app = createServer({ accessToken: token, authority: headers.host, listRuns: () => [{ id: "run", workflowVersionId: "version", status: "queued", secret: "hidden" }] });
  t.after(() => app.close());
  const response = await app.inject({ url: "/api/runs?limit=1&offset=0", headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].secret, undefined);
});
