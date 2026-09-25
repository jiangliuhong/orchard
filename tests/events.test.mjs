import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventRepository, initializeDatabase } from "../dist/storage/database.js";

test("incoming events are idempotent by source and event id and conflict on changed payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-events-"));
  const db = initializeDatabase(dir);
  try {
    const events = new EventRepository(db);
    const first = events.receive({ source: "fixture", eventId: "evt-1", name: "created", data: { n: 1 } });
    const duplicate = events.receive({ source: "fixture", eventId: "evt-1", name: "created", data: { n: 1 } });
    assert.equal(first.duplicate, false);
    assert.deepEqual(duplicate, { id: first.id, duplicate: true });
    assert.throws(() => events.receive({ source: "fixture", eventId: "evt-1", name: "created", data: { n: 2 } }), /conflicts/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
