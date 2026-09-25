import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { RunQueue, canAutoRetry, executeWithRetry } from "../dist/scheduler/run-queue.js";

test("run queue enforces global concurrency and rejects duplicate ids", async () => {
  const queue = new RunQueue(2);
  let active = 0;
  let peak = 0;
  const work = (id) => queue.enqueue({ id, run: async () => { active++; peak = Math.max(peak, active); await delay(20); active--; return id; } });
  const results = await Promise.all([work("a"), work("b"), work("c"), work("d")]);
  assert.deepEqual(results, ["a", "b", "c", "d"]);
  assert.equal(peak, 2);
  const duplicate = queue.enqueue({ id: "x", run: async () => { await delay(20); return "x"; } });
  await assert.rejects(() => queue.enqueue({ id: "x", run: async () => "x" }), /already queued/);
  await duplicate;
  queue.close();
  await assert.rejects(() => queue.enqueue({ id: "closed", run: async () => "never" }), /closed/);
});

test("queue cancellation reaches active work and removes queued work", async () => {
  const queue = new RunQueue(1);
  let started = false;
  const active = queue.enqueue({ id: "active", run: async (signal) => { started = true; await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); } });
  await delay(5);
  assert.equal(started, true);
  const queued = queue.enqueue({ id: "queued", run: async () => "no" });
  assert.equal(queue.cancel("queued", "user stop"), true);
  assert.equal(queue.cancel("active"), true);
  await assert.rejects(active, /aborted/);
  await assert.rejects(queued, /user stop/);
  assert.equal(queue.cancel("missing"), false);
});

test("automatic retry is limited to safe side effects", async () => {
  assert.equal(canAutoRetry({ maxAttempts: 2, sideEffects: "read_only" }, 1), true);
  assert.equal(canAutoRetry({ maxAttempts: 2, sideEffects: "unknown" }, 1), false);
  let attempts = 0;
  const result = await executeWithRetry(async () => { attempts++; if (attempts === 1) throw new Error("transient"); return "ok"; }, { maxAttempts: 2, sideEffects: "idempotent", backoffMs: () => 0 });
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  await assert.rejects(() => executeWithRetry(async () => { throw new Error("side effect"); }, { maxAttempts: 3, sideEffects: "non_idempotent", backoffMs: () => 0 }), /side effect/);
});
