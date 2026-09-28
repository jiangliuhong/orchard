import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationsLog } from "../dist/storage/database.js";

test("operations log writes correlation ids under the instance root", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchard-log-"));
  try { const log = new OperationsLog(root); const id = await log.write({ operation: "publication", status: "succeeded" }); const line = await readFile(join(root, "logs", "operations.jsonl"), "utf8"); assert.match(line, new RegExp(id)); assert.match(line, /publication/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
