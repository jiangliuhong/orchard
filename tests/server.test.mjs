import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../dist/server/app.js";

test("server exposes health and the initial workbench", async (t) => {
  const app = createServer();
  t.after(() => app.close());

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), {
    status: "ok",
    service: "orchard",
    version: "0.1.0",
  });

  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Orchard/);
});
