import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCron, CronScheduler } from "../dist/scheduler/index.js";
import { signWorkerLease, verifyWorkerLease } from "../dist/runtime/remote-worker.js";
import { HttpPiClient } from "../dist/integrations/pi/index.js";

test("cron parser and scheduler produce deterministic occurrences", async () => {
  const schedule = parseCron("*/5 * * * *");
  assert.equal(schedule.next(new Date("2026-09-25T00:00:00Z")).toISOString(), "2026-09-25T00:05:00.000Z");
  const scheduler = new CronScheduler(); let fired = 0;
  scheduler.add({ id: "fixture", schedule, run: () => { fired += 1; } }, new Date("2026-09-25T00:00:00Z"));
  await scheduler.tick(new Date("2026-09-25T00:05:00Z")); scheduler.close(); assert.equal(fired, 1);
});

test("worker leases are signed and expire", () => {
  const lease = signWorkerLease({ runId: "run", owner: "worker", generation: 1, expiresAt: Date.now() + 10_000 }, "secret");
  assert.equal(verifyWorkerLease(lease, "secret"), true); assert.equal(verifyWorkerLease(lease, "wrong"), false); assert.equal(verifyWorkerLease({ ...lease, expiresAt: 0 }, "secret"), false);
});

test("HTTP Pi client sends a real gateway request", async () => {
  let request;
  const client = new HttpPiClient({ endpoint: "https://pi.example", apiKey: "key", fetch: async (_url, init) => { request = { url: _url, init }; return new Response(JSON.stringify({ output: { ok: true }, provider: "pi", model: "real" }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const session = await client.createSession({ signal: new AbortController().signal, allowedTools: ["clock"] });
  const result = await session.run({ prompt: "hello" }, new AbortController().signal);
  assert.deepEqual(result.output, { ok: true }); assert.equal(request.url, "https://pi.example/sessions"); assert.match(request.init.headers.authorization, /Bearer key/);
});
