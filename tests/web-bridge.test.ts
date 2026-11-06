import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeMessages, encodeNativeMessage, decodeLine, encodeLine } from "../src/web-bridge/protocol.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native messaging framing handles partial and batched frames", () => {
  const first = encodeNativeMessage({ id: "a", result: 1 }), second = encodeNativeMessage({ id: "b", result: 2 });
  const split = decodeNativeMessages(first.subarray(0, 3));
  assert.deepEqual(split.values, []);
  const complete = decodeNativeMessages(Buffer.concat([split.rest, first.subarray(3), second]));
  assert.deepEqual(complete.values, [{ id: "a", result: 1 }, { id: "b", result: 2 }]);
  assert.equal(complete.rest.length, 0);
});

test("line framing rejects oversized messages and preserves JSON", () => {
  assert.deepEqual(decodeLine(encodeLine({ ok: true }).trim()), { ok: true });
  assert.throws(() => encodeLine({ value: "x".repeat(512 * 1024) }), /BRIDGE_MESSAGE_TOO_LARGE/);
});

test("web bridge config writes restricted environment state atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "orchard-web-bridge-")), config = new WebBridgeConfig(root);
  config.saveApplication({ id: "acctrix", name: "Acctrix" });
  const saved = config.saveEnvironment("acctrix", { origin: "https://fm.example.test" });
  assert.equal(config.environments("acctrix")[0]?.origin, "https://fm.example.test");
  assert.throws(() => config.saveEnvironment("acctrix", { origin: "https://fm.example.test/path" }), error => (error as { code?: string }).code === "INVALID_ORIGIN");
  config.setToolEnabled("acctrix", "fm_task_list", false);
  assert.equal(config.toolEnabled("acctrix", "fm_task_list"), false);
  assert.match(readFileSync(join(root, "config", "web-bridge.json"), "utf8"), new RegExp(saved.id));
  const deleted = config.deleteApplication("acctrix");
  assert.equal(deleted.applicationId, "acctrix");
  assert.deepEqual(config.applications(), []);
});
