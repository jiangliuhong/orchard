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

test("run detail links serve the workbench on direct visits while missing runs return an API error", async (t) => {
  const app = createServer({ getRun: () => undefined });
  t.after(() => app.close());
  const list = await app.inject({ url: "/runs" });
  const detail = await app.inject({ url: "/runs/run-1" });
  assert.equal(detail.statusCode, 200);
  assert.match(detail.headers["content-type"], /text\/html/);
  assert.equal(detail.body, list.body);
  assert.equal(detail.headers["cache-control"], "no-store");
  const missing = await app.inject({ url: "/api/runs/run-1" });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.headers["content-type"], /application\/json/);
});


test('Monaco CSS and worker are served locally with correct types and a fixed asset path', async t => {
  const app = createServer();
  t.after(() => app.close());
  const page = await app.inject({ url: '/workflows/fixture' });
  assert.match(page.body, /href="\/editor\.css"/);
  const css = await app.inject({ url: '/editor.css' });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.match(css.body, /monaco-editor/);
  const worker = await app.inject({ url: '/editor-assets/editor.worker.js' });
  assert.equal(worker.statusCode, 200);
  assert.match(worker.headers['content-type'], /application\/javascript/);
  assert.ok(worker.body.length > 1000);
  assert.equal((await app.inject({ url: '/editor-assets/unknown.worker.js' })).statusCode, 404);
});
