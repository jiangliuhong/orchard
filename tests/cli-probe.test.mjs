import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  probeBackend,
  probePiReadiness,
  probeVersion,
  versionVerifier,
} from "../dist/integrations/pi/probe.js";

async function script(name, body, executable = true) {
  const dir = await mkdtemp(join(tmpdir(), "orchard-probe-"));
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path, body, { encoding: "utf8", mode: 0o755 });
  await chmod(path, executable ? 0o755 : 0o644);
  return { path, dir };
}

test("probeVersion reports the trimmed version line", async () => {
  const { path, dir } = await script("cli", "#!/bin/sh\necho 'pi 1.2.3'\n");
  try {
    const probe = await probeVersion(path);
    assert.equal(probe.available, true);
    assert.equal(probe.version, "pi 1.2.3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probeVersion reports non-zero exits and start failures as unavailable", async () => {
  const failing = await script("failing", "#!/bin/sh\necho broken >&2\nexit 3\n");
  const dead = await script("dead", "#!/bin/sh\nexit 0\n", false);
  try {
    const failed = await probeVersion(failing.path);
    assert.equal(failed.available, false);
    assert.match(failed.reason, /code 3/);

    const unavailable = await probeVersion(dead.path);
    assert.equal(unavailable.available, false);
    assert.ok(unavailable.reason);
  } finally {
    await rm(failing.dir, { recursive: true, force: true });
    await rm(dead.dir, { recursive: true, force: true });
  }
});

test("probeVersion surfaces timeouts as unavailability", async () => {
  const { path, dir } = await script("slow", "#!/bin/sh\nsleep 5\n");
  try {
    const probe = await probeVersion(path, { timeoutMs: 150 });
    assert.equal(probe.available, false);
    assert.match(probe.reason, /exceeded|cancelled|timeout/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probeBackend carries path and source; versionVerifier adapts for discovery", async () => {
  const { path, dir } = await script("cli", "#!/bin/sh\necho 'codex 0.20.0'\n");
  try {
    const probe = await probeBackend("codex-cli", {
      executable: path,
      source: "discovered",
      defaultTimeoutMs: 1,
      maxOutputBytes: 2,
      killGraceMs: 3,
    });
    assert.equal(probe.launcher, "codex-cli");
    assert.equal(probe.path, path);
    assert.equal(probe.source, "discovered");
    assert.equal(probe.version, "codex 0.20.0");
    assert.equal(await versionVerifier()(path), true);
    assert.equal(await versionVerifier()("/definitely/not/here"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probePiReadiness maps exit codes and missing models", async () => {
  const ready = await script("pi", "#!/bin/sh\nprintf '%s' '{\"ready\":true}\\n'\n");
  const denied = await script("pi", "#!/bin/sh\necho '403 unauthorized' >&2\nexit 1\n");
  try {
    const ok = await probePiReadiness(ready.path, "gpt-4o");
    assert.equal(ok.state, "ready");

    const failed = await probePiReadiness(denied.path, "gpt-4o");
    assert.equal(failed.state, "failed");
    assert.match(failed.reason, /403 unauthorized/);

    const unchecked = await probePiReadiness(ready.path, "");
    assert.equal(unchecked.state, "unchecked");
    assert.match(unchecked.reason, /no explicit model/);
  } finally {
    await rm(ready.dir, { recursive: true, force: true });
    await rm(denied.dir, { recursive: true, force: true });
  }
});
