import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../dist/server/app.js";

const headers = { host: "127.0.0.1:7331" };

test("cli backend settings endpoints report connection, deep flag and path normalization", async (t) => {
  const calls = [];
  const app = createServer({
    authority: headers.host,
    cliBackendStatus: (deep) => [{ launcher: "pi-cli", path: "/bin/pi", source: "discovered", available: true, version: "pi 1.1.0", deep }],
    setCliBackendPath: (launcher, path) => { calls.push({ launcher, path }); return { launcher, path, saved: true }; },
  });
  t.after(() => app.close());

  assert.equal((await app.inject({ url: "/api/settings/cli-backends", headers })).statusCode, 200);
  const shallow = (await app.inject({ url: "/api/settings/cli-backends", headers })).json().items[0];
  assert.equal(shallow.deep, false);
  const deep = (await app.inject({ url: "/api/settings/cli-backends?readiness=deep", headers })).json().items[0];
  assert.equal(deep.deep, true);

  const put = await app.inject({ method: "PUT", url: "/api/settings/cli-backends/pi-cli", headers, payload: { path: "/opt/pi/bin/pi" } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(calls, [{ launcher: "pi-cli", path: "/opt/pi/bin/pi" }]);

  const clear = await app.inject({ method: "PUT", url: "/api/settings/cli-backends/codex-cli", headers, payload: { path: "" } });
  assert.equal(clear.statusCode, 200);
  assert.deepEqual(calls[1], { launcher: "codex-cli", path: null });
});

test("cli backend settings endpoints reject unknown launchers, missing options and failed probes", async (t) => {
  const app = createServer({
    authority: headers.host,
    setCliBackendPath: () => { throw new Error("--version exited with code 1: not a CLI"); },
  });
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "PUT", url: "/api/settings/cli-backends/other-cli", headers, payload: { path: "/x" } })).statusCode, 400);
  const rejected = await app.inject({ method: "PUT", url: "/api/settings/cli-backends/pi-cli", headers, payload: { path: "/x" } });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().code, "CLI_BACKEND_PATH_REJECTED");
  assert.match(rejected.json().message, /--version/);
  const unavailable = await app.inject({ url: "/api/settings/cli-backends", headers });
  assert.equal(unavailable.statusCode, 503);
});

test("agent API enforces the launcher enum and surfaces profile validation errors", async (t) => {
  const created = [];
  const app = createServer({
    authority: headers.host,
    createAgent: (input) => {
      if (input.config && typeof input.config === "object" && "evil" in input.config) {
        throw Object.assign(new Error('Agent config field "evil" is not supported'), { code: "INVALID_AGENT_PROFILE" });
      }
      created.push(input);
      return { id: "agent-1", name: input.name, provider: input.provider, model: input.model, config: input.config ?? {}, allowedTools: input.allowedTools ?? [], createdAt: 0, updatedAt: 0 };
    },
  });
  t.after(() => app.close());

  const ok = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "helper", provider: "pi-cli", model: "" } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(created, [{ name: "helper", provider: "pi-cli", model: "" }]);

  const legacy = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "x", provider: "openai", model: "gpt-4o" } });
  assert.equal(legacy.statusCode, 400);

  const injection = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "x", provider: "pi-cli", model: "", config: { evil: "--danger" } } });
  assert.equal(injection.statusCode, 400);
  assert.equal(injection.json().code, "INVALID_AGENT_PROFILE");

  const secret = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "x", provider: "pi-cli", model: "", secretRef: "vault:pi" } });
  assert.equal(secret.statusCode, 400); // additionalProperties: false — secretRef is no longer accepted
});

test("agent listing annotates legacy rows and never returns secret_ref", async (t) => {
  const app = createServer({
    authority: headers.host,
    listAgents: () => [
      { id: "ok", name: "ok", provider: "pi-cli", model: "", config: {}, allowedTools: [], createdAt: 0, updatedAt: 0 },
      { id: "legacy", name: "legacy", provider: "openai", model: "gpt-4o", config: {}, allowedTools: [], secretRef: "vault:legacy", createdAt: 0, updatedAt: 0 },
    ],
  });
  t.after(() => app.close());
  const { items } = (await app.inject({ url: "/api/agents", headers })).json();
  assert.equal(items.length, 2);
  assert.equal("validationError" in items[0], false);
  assert.equal("secretRef" in items[0], false);
  assert.match(items[1].validationError, /pi-cli \| codex-cli/);
  assert.equal("secretRef" in items[1], false);
});
