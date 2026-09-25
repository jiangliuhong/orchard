import assert from "node:assert/strict";
import { test } from "node:test";
import { PiAdapter, PiNotConfiguredError } from "../dist/integrations/pi/index.js";

test("Pi adapter reports missing configuration instead of faking output", async () => {
  await assert.rejects(() => new PiAdapter().execute({ prompt: "hello" }, new AbortController().signal), (error) => error instanceof PiNotConfiguredError && error.code === "PI_NOT_CONFIGURED");
});

test("Pi adapter validates structured output and forwards cancellation", async () => {
  let cancelled = false;
  const adapter = new PiAdapter({
    async createSession() {
      return {
        async run() { await new Promise((resolve) => setTimeout(resolve, 30)); return { output: { answer: 42 }, provider: "fixture", model: "fixture" }; },
        async cancel() { cancelled = true; },
      };
    },
  });
  const controller = new AbortController();
  const pending = adapter.execute({ prompt: "x", outputSchema: { type: "object", required: ["answer"] } }, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
  await assert.rejects(() => adapter.execute({ prompt: "x", outputSchema: { type: "string" } }, new AbortController().signal), /output validation failed/);
});
