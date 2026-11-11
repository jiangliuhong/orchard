import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Agent schema approval preserves the exact reviewed snapshot and excludes automatic destructive execution", () => {
  const root = new URL("../", import.meta.url);
  const approval = JSON.parse(readFileSync(new URL("docs/features/2026-11-11-unified-agent-runtime/schema-approval.json", root), "utf8"));
  assert.equal(approval.status, "approved");
  assert.equal(approval.reviewer, "user");
  assert.equal(approval.evidence.message, "批准");
  const snapshot = readFileSync(new URL(approval.reviewSnapshot, root));
  assert.equal(createHash("sha256").update(snapshot).digest("hex"), approval.reviewedDocumentSha256);
  assert.match(approval.authorization, /requires separate explicit confirmation/);
  assert.match(approval.activation, /before full runtime cutover/);
});
