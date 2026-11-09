import { test } from "node:test";
import assert from "node:assert/strict";
import { postprocessResponse } from "../src/web-bridge/postprocess.js";
import { executeHttpTool, validateStoredHttpTool } from "../src/web-bridge/execution.js";
import { bridgeAuthoringContract, BRIDGE_AUTHORING_GUIDANCE } from "../src/web-bridge/authoring.js";

test("postprocess transforms JSON with args and preserves unconfigured responses", async () => {
  const signal = new AbortController().signal;
  const response = { data: { list: [1, 2] } };
  assert.equal(await postprocessResponse(undefined, response, {}, signal, 1000, []), response);
  assert.deepEqual(await postprocessResponse({ runtime: "nodejs", code: "return {items:response.data.list,total:args.total};" }, response, { total: 2 }, signal, 1000, []), { items: [1, 2], total: 2 });
});

test("postprocess fails closed for invalid results, errors, oversized output, timeout and secret echoes", async () => {
  for (const code of [
    "return undefined;", "throw new Error('private-error');", "return 1n;",
    "return 'x'.repeat(2000);", "while(true) {}", "return args.secret;",
    "return await (await import('node:fs/promises')).readFile('/etc/hosts','utf8');",
  ]) {
    await assert.rejects(postprocessResponse({ runtime: "nodejs", code, timeoutMs: 200 }, {}, { secret: "private-secret" }, new AbortController().signal, 1000, ["private-secret"]), error => {
      assert.doesNotMatch((error as Error).message, /private-error|private-secret/);
      return true;
    });
  }
});

test("postprocess respects caller cancellation", async () => {
  const controller = new AbortController();
  const pending = postprocessResponse({ runtime: "nodejs", code: "await new Promise(()=>{});" }, {}, {}, controller.signal, 1000, []);
  controller.abort();
  await assert.rejects(pending);
});

test("local HTTP applies field filtering before transformation and validates both execution schemas", async () => {
  const postprocess = { runtime: "nodejs" as const, code: "return {value:response.keep,removed:response.drop===undefined};" };
  const execution = { version: 1 as const, transport: "localHttp" as const, response: { mode: "fields" as const, maxBytes: 1000 }, postprocess };
  validateStoredHttpTool({ path: "/query", method: "GET", parameters: {}, execution });
  validateStoredHttpTool({ path: "/query", method: "GET", parameters: {}, execution: { ...execution, transport: "browser", preprocess: { runtime: "nodejs", code: "return request;" } } });
  assert.throws(() => validateStoredHttpTool({ path: "/query", method: "GET", parameters: {}, execution: { ...execution, postprocess: { ...postprocess, timeoutMs: 10001 } } }));
  const result = await executeHttpTool({ path: "/query", method: "GET", fields: ["keep"], execution }, "https://example.com", {}, new AbortController().signal, { fetch: async () => Response.json({ keep: 42, drop: 7 }) });
  assert.deepEqual(result, { value: 42, removed: true });
  assert.match(BRIDGE_AUTHORING_GUIDANCE, /execution.postprocess/);
  assert.match(bridgeAuthoringContract("app").capabilities.responsePostprocess, /response and args/);
});
