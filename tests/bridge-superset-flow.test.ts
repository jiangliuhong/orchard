import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createApp } from "../src/server/app.js";
import { maintenanceProposalSchema } from "../src/agent/maintenance-protocol.js";
import { assertSchema } from "../src/domain/validation.js";
import { prepareBridgeProposal } from "../src/web-bridge/authoring.js";
import type { WebBridgeTool } from "../src/web-bridge/catalog.js";
import { setup } from "./helpers.js";

const sample: WebBridgeTool = JSON.parse(readFileSync(new URL("./fixtures/browser-tools/superset-sql-query.json", import.meta.url), "utf8"));
const tableSample: WebBridgeTool = JSON.parse(readFileSync(new URL("./fixtures/browser-tools/superset-table-list.json", import.meta.url), "utf8"));
const background = readFileSync(new URL("../src/web-bridge/extension/background.js", import.meta.url), "utf8");
const browserFunction = background.slice(background.indexOf("async function executeBrowserRequest"), background.indexOf("let profileReady;"));
const profileId = "superset-test";
const origin = "https://superset.test";
const token = "superset-session-csrf";
const path = {
  databases: "/api/v1/database/",
  tables: "/api/v1/database/12/tables/",
  search: "/api/v1/database/12/tables/search/",
  csrf: "/api/v1/security/csrf_token/",
  execute: "/api/v1/sqllab/execute/",
  status: "/api/v1/query/99",
  results: "/api/v1/sqllab/results/",
};

test("Superset proposal saves and runs synchronous and asynchronous calls through the browser bridge", async t => {
  const { store, providers } = setup(t);
  const { app, bridge } = createApp(store, providers);
  await app.ready();
  t.after(() => app.close());
  const proposal = (definition: WebBridgeTool) => ({
    summary: "新增 Superset SQL Lab 查询",
    changes: [{ operation: "create", toolId: definition.toolId, definition }],
  });
  const tableExecution = tableSample.execution;
  assert.ok(tableExecution?.transport === "browser" && tableExecution.flow);
  const postSearch: WebBridgeTool = {
    ...tableSample,
    toolId: "table_search",
    execution: {
      ...tableExecution,
      flow: { ...tableExecution.flow, steps: [{ ...tableExecution.flow.steps[0], method: "POST", path: "/api/v1/database/{databaseId}/tables/search/" }] },
    },
  };
  for (const risk of ["write", "delete", "execute"] as const) {
    assert.throws(() => prepareBridgeProposal("superset", [], proposal({ ...sample, risk, approval: "none" })), { code: "INVALID_BROWSER_FLOW" });
  }
  const target = { kind: "browser_application" as const, id: "superset", scope: {} };
  const baseline = { revision: 1 };
  const schema = maintenanceProposalSchema({ target, baseline });
  assert.match(JSON.stringify(schema), /query is a preprocess return field/);
  const { summary, changes } = proposal(sample);
  assertSchema({ contractVersion: "orchard.maintenance.v1", requestId: "superset-create", target, baseline, summary,
    change: { operation: "tools", changes } }, schema, "Superset maintenance submission");
  const { candidate } = prepareBridgeProposal("superset", [], proposal(sample));
  bridge.saveApplication({ id: "superset", name: "Superset" });
  bridge.saveTool(candidate[0]!);
  bridge.saveTool(tableSample);
  bridge.saveTool(postSearch);
  for (const risk of ["write", "delete"] as const) {
    const tool = bridge.saveTool({ ...sample, toolId: `requires_${risk}`, risk });
    const response = await app.inject({
      method: "POST", url: "/api/web-bridge/calls",
      payload: { application: "superset", tool: tool.toolId, args: { sql: "SELECT 1" } },
    });
    assert.equal(response.json().code, "APPROVAL_REQUIRED");
  }
  bridge.saveEnvironment("superset", { origin, profileId });
  const extensionOrigin = "chrome-extension://" + "a".repeat(32);
  const registration = await app.inject({
    method: "POST", url: "/api/web-bridge/profiles/register", headers: { origin: extensionOrigin },
    payload: { id: profileId, name: "Superset Test", extensionId: "a".repeat(32) },
  });
  const headers = { origin: extensionOrigin, "x-orchard-bridge-token": registration.json().bridgeToken };
  const call = (runAsync: boolean, approved = true, sql = "SELECT 1") => app.inject({
    method: "POST", url: "/api/web-bridge/calls",
    payload: { application: "superset", tool: "superset_sql_query", approved, args: { sql, runAsync } },
  });
  assert.equal((await call(false, false)).json().code, "APPROVAL_REQUIRED");
  assert.equal((await call(false, true, "SELECT 1; DROP TABLE x")).json().code, "PREPROCESS_FAILED");
  for (const mode of ["sync", "async", "failed", "exhausted", "echo", "cancelled", "missing", "duplicate", "tables", "post-search"] as const) {
    const runAsync = ["async", "failed", "exhausted", "cancelled"].includes(mode);
    const tableTool = mode === "tables" ? tableSample : mode === "post-search" ? postSearch : undefined;
    const pending = (tableTool ? app.inject({
      method: "POST", url: "/api/web-bridge/calls",
      payload: { application: "superset", tool: tableTool.toolId, args: { schema: "a!'&b" } },
    }) : call(runAsync)).then(value => value);
    let item: { id: string; payload: { sequence: { flow: { steps: { poll?: { maxAttempts: number } }[] } } } } | undefined;
    for (let attempt = 0; !item && attempt < 100; attempt++) {
      [item] = (await app.inject({ method: "POST", url: "/api/web-bridge/browser/poll", headers, payload: { profileId } })).json().items;
      if (!item) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(item);
    assert.equal("request" in item.payload, false);
    assert.ok(!JSON.stringify(item.payload).includes(token));
    if (mode === "exhausted") item.payload.sequence.flow.steps[2]!.poll!.maxAttempts = 1;
    const visited: string[] = [];
    let polls = 0;
    let instances = 0;
    const cancellation = new AbortController();
    const sandbox = {
      AbortController, AbortSignal, URL, TextDecoder, TextEncoder, Uint8Array, setTimeout, clearTimeout, cancellation, location: { origin },
      manageBridgeTab: async () => ({ state: "ready", tabId: 7 }),
      chrome: { scripting: {
        executeScript: async (options: { world: string; target: { tabId: number }; func: (...args: unknown[]) => Promise<unknown>; args: unknown[] }) => {
          assert.equal(options.world, "ISOLATED");
          assert.equal(options.target.tabId, 7);
          if (options.args.length > 1) instances++;
          return [{ result: await options.func(...options.args) }];
        },
      } },
      fetch: async (raw: string, options: RequestInit) => {
        const url = new URL(raw);
        assert.equal(url.origin, origin);
        assert.equal(options.credentials, "include");
        assert.equal(options.redirect, "error");
        visited.push(url.pathname);
        switch (url.pathname) {
          case path.databases: {
            const exact = { id: 12, database_name: "test_starrocks" };
            const result = [{ id: 10, database_name: "test_starrocks_backup" }];
            if (mode !== "missing") result.push(exact);
            if (mode === "duplicate") result.push({ ...exact, id: 13 });
            return Response.json({ result });
          }
          case path.tables:
          case path.search:
            assert.equal(options.method, mode === "post-search" ? "POST" : "GET");
            assert.equal(url.searchParams.get("q"), "(schema_name:'a!!!'&b')");
            assert.equal(url.searchParams.size, 1);
            return Response.json({ result: [{ name: "sample", type: "table" }] });
          case path.csrf: return Response.json({ result: token });
          case path.execute:
            assert.equal(options.method, "POST");
            assert.equal((options.headers as Record<string, string>)["X-CSRFToken"], token);
            assert.deepEqual(JSON.parse(options.body as string), { database_id: 12, sql: "SELECT 1", runAsync, json: true });
            return Response.json(runAsync ? { data: { query: { id: 99, status: "running" } } }
              : { columns: ["id"], data: [{ id: mode === "echo" ? token : 1 }] });
          case path.status:
            polls++;
            if (mode === "cancelled") cancellation.abort();
            return Response.json({ result: { id: 99, status: mode === "failed" ? "failed" : polls === 1 ? "running" : "success", results_key: polls === 1 ? null : "a!'&b" } });
          case path.results:
            assert.equal(url.searchParams.get("q"), "(key:'a!!!'&b',rows:!n)");
            assert.equal(url.searchParams.size, 1);
            return Response.json({ query_id: 99, columns: [{ name: "id" }], data: [{ id: 1 }] });
          default: throw new Error("Unexpected endpoint");
        }
      },
    };
    let reported: { result?: unknown; error?: string };
    try {
      const result = await runInNewContext(`${browserFunction}\nexecuteBrowserRequest(${JSON.stringify(item.payload)}, ${JSON.stringify(item.id)}, cancellation.signal)`, sandbox);
      reported = { result };
    } catch (error) {
      reported = { error: (error as Error).message };
    }
    assert.ok(!JSON.stringify(reported).includes(token));
    assert.equal((await app.inject({ method: "POST", url: "/api/web-bridge/browser/result", headers, payload: { profileId, id: item.id, ...reported } })).statusCode, 200);
    const response = await pending;
    assert.equal(instances, 1);
    const expectedPaths = mode === "async" ? [path.csrf, path.execute, path.status, path.status, path.results]
      : runAsync ? [path.csrf, path.execute, path.status] : [path.csrf, path.execute];
    const lookupFailed = mode === "missing" || mode === "duplicate";
    assert.deepEqual(visited, lookupFailed ? [path.databases] : tableTool ? [path.databases, mode === "post-search" ? path.search : path.tables] : [path.databases, ...expectedPaths]);
    if (tableTool) assert.deepEqual(response.json(), [{name: "sample", type: "table", schema: "a!'&b"}]);
    else if (mode === "missing") assert.equal(response.json().code, "BROWSER_FLOW_MATCH_NOT_FOUND");
    else if (mode === "duplicate") assert.equal(response.json().code, "BROWSER_FLOW_MATCH_AMBIGUOUS");
    else if (mode === "echo") assert.equal(response.json().code, "SENSITIVE_RESPONSE");
    else if (mode === "failed") assert.equal(response.json().code, "BROWSER_FLOW_FAILED");
    else if (mode === "exhausted" || mode === "cancelled") assert.equal(response.json().code, "BROWSER_FLOW_TIMEOUT");
    else assert.deepEqual(response.json(), { columns: ["id"], rows: [{ id: 1 }], rowCount: 1, truncated: false });
  }
});
