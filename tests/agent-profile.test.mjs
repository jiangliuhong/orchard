import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeDatabase, AgentProfileRepository } from "../dist/storage/database.js";
import {
  agentProfileValidationError,
  InvalidAgentProfileError,
  validateAgentProfile,
} from "../dist/integrations/pi/profile.js";

function rejects(input, pattern) {
  assert.throws(() => validateAgentProfile(input), (error) => {
    assert.ok(error instanceof InvalidAgentProfileError);
    assert.equal(error.code, "INVALID_AGENT_PROFILE");
    assert.equal(error.retryable, false);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("validateAgentProfile accepts a fully specified pi-cli profile", () => {
  const profile = validateAgentProfile({
    name: "report-helper",
    provider: "pi-cli",
    model: "anthropic/claude-sonnet",
    config: { timeoutMs: 120_000, thinkingLevel: "medium" },
    allowedTools: ["read", "bash"],
  });
  assert.equal(profile.launcher, "pi-cli");
  assert.equal(profile.model, "anthropic/claude-sonnet");
  assert.equal(profile.timeoutMs, 120_000);
  assert.equal(profile.thinkingLevel, "medium");
  assert.deepEqual(profile.allowedTools, ["read", "bash"]);
  assert.equal(profile.codexSandbox, "read-only");
});

test("validateAgentProfile accepts a minimal codex-cli profile with empty model", () => {
  const profile = validateAgentProfile({ name: "codex", provider: "codex-cli", model: "" });
  assert.equal(profile.launcher, "codex-cli");
  assert.equal(profile.model, "");
  assert.deepEqual(profile.allowedTools, []);
  assert.equal(profile.codexSandbox, "read-only");
  assert.equal(profile.timeoutMs, undefined);
});

test("validateAgentProfile rejects providers outside the launcher enum", () => {
  rejects({ name: "x", provider: "openai", model: "gpt-4o" }, /pi-cli \| codex-cli/);
  rejects({ name: "x", provider: "", model: "" }, /pi-cli \| codex-cli/);
});

test("validateAgentProfile rejects unsupported config keys (no argument injection)", () => {
  rejects({ name: "x", provider: "pi-cli", model: "", config: { extraArgs: "--danger" } }, /not supported/);
  rejects({ name: "x", provider: "pi-cli", model: "", config: { model: "smol" } }, /not supported/);
  rejects({ name: "x", provider: "pi-cli", model: "", config: [] }, /must be an object/);
});

test("validateAgentProfile bounds timeoutMs to the hard ceiling", () => {
  rejects({ name: "x", provider: "pi-cli", model: "", config: { timeoutMs: 0 } }, /timeoutMs/);
  rejects({ name: "x", provider: "pi-cli", model: "", config: { timeoutMs: 900_001 } }, /timeoutMs/);
  rejects({ name: "x", provider: "pi-cli", model: "", config: { timeoutMs: 10.5 } }, /timeoutMs/);
});

test("validateAgentProfile keeps thinkingLevel pi-only and enumerated", () => {
  rejects({ name: "x", provider: "codex-cli", model: "", config: { thinkingLevel: "off" } }, /pi-cli/);
  rejects({ name: "x", provider: "pi-cli", model: "", config: { thinkingLevel: "ultra" } }, /thinkingLevel/);
});

test("validateAgentProfile maps the codex write sentinel and rejects tool allowlists on codex", () => {
  const write = validateAgentProfile({ name: "x", provider: "codex-cli", model: "", allowedTools: ["workspace-write"] });
  assert.equal(write.codexSandbox, "workspace-write");
  rejects({ name: "x", provider: "codex-cli", model: "", allowedTools: ["bash"] }, /workspace-write/);
});

test("validateAgentProfile bounds model and tool entries", () => {
  rejects({ name: "x", provider: "pi-cli", model: "m".repeat(201) }, /model/);
  rejects({ name: "x", provider: "pi-cli", model: "", allowedTools: ["t".repeat(101)] }, /1\.\.100/);
  rejects(
    { name: "x", provider: "pi-cli", model: "", allowedTools: Array.from({ length: 51 }, (_, i) => `tool-${i}`) },
    /at most 50/,
  );
  rejects({ name: "", provider: "pi-cli", model: "" }, /name/);
});

test("agentProfileValidationError returns a message for legacy rows and undefined for valid ones", () => {
  assert.equal(agentProfileValidationError({ name: "ok", provider: "pi-cli", model: "", config: {}, allowedTools: [] }), undefined);
  assert.match(agentProfileValidationError({ name: "legacy", provider: "openai", model: "gpt-4o", config: {}, allowedTools: [] }), /pi-cli \| codex-cli/);
});

test("AgentProfileRepository.create validates input and stops writing secret_ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-agents-"));
  const db = initializeDatabase(dir);
  try {
    const agents = new AgentProfileRepository(db);
    const created = agents.create({ name: "helper", provider: "pi-cli", model: "", config: { timeoutMs: 5_000 }, allowedTools: ["read"] });
    assert.equal(created.provider, "pi-cli");
    assert.equal(created.secretRef, undefined);
    const row = db.database.prepare("SELECT config_json, allowed_tools_json, secret_ref FROM agent_profiles WHERE id = ?").get(created.id);
    assert.equal(row.secret_ref, null);
    assert.deepEqual(JSON.parse(row.config_json), { timeoutMs: 5_000 });
    assert.deepEqual(JSON.parse(row.allowed_tools_json), ["read"]);

    assert.throws(
      () => agents.create({ name: "bad", provider: "openai", model: "gpt-4o" }),
      (error) => error instanceof InvalidAgentProfileError,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
