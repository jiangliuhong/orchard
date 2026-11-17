import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/server/app.js";
import { setup, until } from "./helpers.js";

test("agent discovery, execution and receipts are scoped to the channel and granted revision", async t => {
  const { store, providers, root } = setup(t);
  const { app, scripts } = createApp(store, providers);
  t.after(() => app.close());
  await app.ready();
  const headers = { host: "localhost" };
  const token = readFileSync(join(root, "runtime", "api-token"), "utf8");
  const machineHeaders = { ...headers, "x-orchard-token": token };
  const mcp = "/api/agent-access/mcp";
  const cli = "/api/agent-access/cli";
  const settings = "/api/settings/agent-access";
  assert.equal((await app.inject({ url: mcp + "/tools", headers })).statusCode, 401);
  const defaults = await app.inject({ url: settings, headers });
  const launchArgs: string[] = defaults.json().installation.args;
  assert.deepEqual(launchArgs.slice(-6), ["quick-launch", "--stdio", "--data-dir", store.root, "--port", "7441"]);
  assert.deepEqual(defaults.json().policy, {
    revision: 0, mcp: { enabled: true, cards: [] }, cli: { enabled: true, cards: [] },
  });

  const script = await scripts.create({
    id: "agent-echo", name: "Agent echo", description: "", runtime: "nodejs", entryFile: "main.ts",
    files: { "main.ts": "export default input => ({ received: input })" },
    inputSchema: { type: "object" }, outputSchema: true, requestId: randomUUID(),
  });
  const published = store.publishScript(script.script.id, script.version.revision);
  const input = {
    name: "Agent echo card", note: "", groupId: null, fixedInput: { message: "fixed input" }, inputSources: {},
    target: { kind: "script", scriptId: script.script.id, versionId: published.version.id },
  };
  const card = await app.inject({ method: "POST", url: "/api/quick-launches", headers, payload: { ...input, requestId: randomUUID() } });
  assert.equal(card.statusCode, 201, card.body);
  const { id, revision } = card.json();
  for (const channel of [mcp, cli]) {
    const listing = await app.inject({ url: channel + "/tools", headers: machineHeaders });
    assert.equal(listing.statusCode, 200, listing.body);
    assert.deepEqual(listing.json(), { items: [] });
  }
  const policy = { revision: 0, mcp: { enabled: true, cards: [{ id, revision }] }, cli: { enabled: true, cards: [] } };
  const put = (value: typeof policy) => app.inject({ method: "PUT", url: settings, headers, payload: value });
  const configured = await put(policy);
  assert.equal(configured.statusCode, 200, configured.body);
  assert.deepEqual((await app.inject({ url: cli + "/tools", headers: machineHeaders })).json(), { items: [] });
  const items = (await app.inject({ url: mcp + "/tools", headers: machineHeaders })).json().items;
  assert.deepEqual(items.map((card: { id: string }) => card.id), [id]);
  assert.equal(items[0].fixedInput, undefined);

  const requestId = randomUUID();
  const run = (channel: string) => app.inject({ method: "POST", url: channel + "/tools/" + id, headers: machineHeaders,
    payload: { revision, requestId } });
  assert.equal((await run(cli)).statusCode, 403);
  const accepted = await run(mcp);
  assert.equal(accepted.statusCode, 202, accepted.body);
  const { executionId } = accepted.json();
  assert.equal((await run(mcp)).json().executionId, executionId);
  const status = (channel: string) => app.inject({ url: channel + "/executions/" + executionId, headers: machineHeaders });
  const result = await until(async () => {
    const response = await status(mcp);
    assert.equal(response.statusCode, 200, response.body);
    const value = response.json();
    return value.status === "succeeded" ? value : null;
  });
  assert.deepEqual(result.output, { received: input.fixedInput });
  assert.equal((await status(cli)).statusCode, 404);

  const changed = await app.inject({ method: "PATCH", url: "/api/quick-launches/" + id, headers,
    payload: { ...input, revision, requestId: randomUUID(), fixedInput: { message: "changed" } } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual((await app.inject({ url: mcp + "/tools", headers: machineHeaders })).json(), { items: [] });
  assert.equal((await run(mcp)).statusCode, 403);
  assert.equal((await status(mcp)).statusCode, 403);
  assert.equal((await put(policy)).statusCode, 409);
  assert.equal((await put({ revision: 1, mcp: { enabled: false, cards: [] }, cli: { enabled: false, cards: [] } })).statusCode, 200);
  assert.equal((await run(mcp)).json().code, "AGENT_ACCESS_DISABLED");
  assert.equal((await run(cli)).json().code, "AGENT_ACCESS_DISABLED");
});

test("legacy browser CLI can only run a matching approved card and returns the quick-launch result", async t => {
  const { store, providers, root } = setup(t);
  const { app, bridge } = createApp(store, providers);
  t.after(() => app.close());
  await app.ready();
  bridge.saveApplication({ id: "sample", name: "Sample" });
  const environment = bridge.saveEnvironment("sample", { origin: "https://example.test" });
  const tool = {
    application: "sample", toolId: "lookup", site: "sample", description: "Look up",
    parameters: { type: "object" }, path: "/lookup", method: "POST" as const, fields: [],
    risk: "read" as const, approval: "none" as const, timeoutMs: 1000, catalogVersion: "1", enabled: true,
    execution: { version: 1 as const, transport: "localHttp" as const, response: { mode: "fullJson" as const, maxBytes: 1000 } },
  };
  bridge.saveTool(tool);
  bridge.saveTool({ ...tool, toolId: "submit", risk: "write", approval: "user" });
  let calls = 0;
  bridge.httpDependencies.fetch = async () => { calls++; return Response.json({ items: ["example"] }); };
  const headers = { host: "localhost" };
  const targets = (await app.inject({ url: "/api/quick-launch-targets", headers })).json().items;
  const fixedInput = { query: "pinned" };
  const createCard = async (toolId: string) => {
    const target = targets.find((item: { target: { toolId?: string; environmentId?: string } }) =>
      item.target.toolId === toolId && item.target.environmentId === environment.id).target;
    const card = await app.inject({ method: "POST", url: "/api/quick-launches", headers, payload: {
      name: toolId, note: "", groupId: null, target, fixedInput, inputSources: {}, requestId: randomUUID(),
    } });
    assert.equal(card.statusCode, 201, card.body);
    const { id, revision } = card.json();
    return { id, revision };
  };
  const lookup = await createCard("lookup");
  const submit = await createCard("submit");
  const set = (cards: (typeof lookup)[]) => app.inject({ method: "PUT", url: "/api/settings/agent-access", headers, payload: {
    revision: 0, mcp: { enabled: false, cards: [] }, cli: { enabled: true, cards },
  } });
  assert.equal((await set([submit])).json().code, "CARD_UNAVAILABLE");
  assert.equal((await set([lookup])).statusCode, 200);

  const machineHeaders = { ...headers, "x-orchard-token": readFileSync(join(root, "runtime", "api-token"), "utf8") };
  const run = (args: unknown) => app.inject({ method: "POST", url: "/api/agent-access/cli/legacy-web-bridge", headers: machineHeaders, payload: {
    application: "sample", tool: "lookup", environmentId: environment.id, args, requestId: randomUUID(),
  } });
  assert.equal((await run({ query: "changed" })).statusCode, 403);
  assert.equal(calls, 0);
  const accepted = await run(fixedInput);
  assert.equal(accepted.statusCode, 202, accepted.body);
  const result = await until(async () => {
    const response = await app.inject({ url: "/api/agent-access/cli/executions/" + accepted.json().executionId, headers: machineHeaders });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().status === "succeeded" ? response.json() : null;
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.output, { items: ["example"] });
});
