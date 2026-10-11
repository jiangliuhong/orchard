import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CliBackendRegistry,
  discoveryCandidates,
  nvmCandidates,
  resolveCliBackends,
} from "../dist/integrations/pi/backends.js";

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "orchard-home-"));
  return home;
}

async function touch(path, executable = true) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  if (executable) await chmod(path, 0o755);
  else await chmod(path, 0o644);
  return path;
}

test("a settings-saved absolute path wins and is pinned with source=settings", async () => {
  const home = await makeHome();
  try {
    const configured = await touch(join(home, "bin", "pi"));
    const registry = await resolveCliBackends({
      settings: { cli: { "pi-cli": { executable: configured } } },
      home,
      verify: () => Promise.resolve(false), // settings paths are not re-verified at resolve time
    });
    const entry = registry.get("pi-cli");
    assert.equal(entry.executable, configured);
    assert.equal(entry.source, "settings");
    assert.equal(entry.defaultTimeoutMs, 300_000);
    assert.equal(entry.maxOutputBytes, 8 * 1024 * 1024);
    assert.equal(registry.get("codex-cli"), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("non-absolute settings values are ignored and discovery takes over", async () => {
  const home = await makeHome();
  try {
    const discovered = await touch(join(home, ".nvm", "versions", "node", "v24.0.0", "bin", "pi"));
    const registry = await resolveCliBackends({
      settings: { cli: { "pi-cli": { executable: "just-pi" } } },
      home,
      verify: () => Promise.resolve(true),
    });
    assert.equal(registry.get("pi-cli").executable, discovered);
    assert.equal(registry.get("pi-cli").source, "discovered");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("nvm candidates are ordered newest Node first and failing verification falls through", async () => {
  const home = await makeHome();
  try {
    const newest = await touch(join(home, ".nvm", "versions", "node", "v24.19.0", "bin", "pi"));
    await touch(join(home, ".nvm", "versions", "node", "v18.20.0", "bin", "pi"));
    assert.equal((await nvmCandidates("pi-cli", home))[0], newest);

    const strict = await resolveCliBackends({
      settings: {},
      home,
      verify: (candidate) => Promise.resolve(candidate === newest),
    });
    assert.equal(strict.get("pi-cli").executable, newest);

    // When the newest fails verification, the next nvm version wins.
    const fallback = await resolveCliBackends({
      settings: {},
      home,
      verify: (candidate) => Promise.resolve(candidate !== newest),
    });
    assert.match(fallback.get("pi-cli").executable, /v18\.20\.0/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unresolvable launchers stay unregistered", async () => {
  const home = await makeHome();
  try {
    const registry = await resolveCliBackends({ settings: {}, home, verify: () => Promise.resolve(true) });
    assert.equal(registry.get("pi-cli"), undefined);
    assert.equal(registry.get("codex-cli"), undefined);
    assert.deepEqual(registry.list(), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("codex has cargo and npm-global candidates; pi does not have cargo", async () => {
  const home = await makeHome();
  try {
    await touch(join(home, ".cargo", "bin", "codex"));
    const registry = await resolveCliBackends({ settings: {}, home, verify: () => Promise.resolve(true) });
    assert.match(registry.get("codex-cli").executable, /\.cargo/);
    assert.equal(registry.get("pi-cli"), undefined);

    const piCandidates = discoveryCandidates("pi-cli", home);
    assert.ok(!piCandidates.some((candidate) => candidate.includes(".cargo")));
    assert.ok(discoveryCandidates("codex-cli", home).some((candidate) => candidate.includes(".cargo")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registry entries are replaced atomically and can be cleared", async () => {
  const registry = new CliBackendRegistry();
  registry.set("pi-cli", { executable: "/a", source: "settings", defaultTimeoutMs: 1, maxOutputBytes: 2, killGraceMs: 3 });
  registry.set("pi-cli", { executable: "/b", source: "discovered", defaultTimeoutMs: 1, maxOutputBytes: 2, killGraceMs: 3 });
  assert.equal(registry.get("pi-cli").executable, "/b");
  registry.delete("pi-cli");
  assert.equal(registry.get("pi-cli"), undefined);
  assert.equal(registry.list().length, 0);
});
