import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../dist/server/app.js";

const token = "test-only-token-".repeat(4);
const headers = { host: "127.0.0.1:7331", authorization: `Bearer ${token}` };
function setup(t, listWorkflows = () => []) {
  const app = createServer({ accessToken: token, authority: headers.host, listWorkflows });
  t.after(() => app.close());
  return app;
}

test("workflow reads require authentication, exact Host and same Origin", async (t) => {
  let calls = 0;
  const app = setup(t, () => { calls++; return []; });
  for (const [requestHeaders, status] of [
    [{ host: headers.host }, 401],
    [{ ...headers, authorization: "Bearer wrong" }, 401],
    [{ ...headers, host: "evil.example:7331" }, 403],
    [{ ...headers, origin: "https://evil.example" }, 403],
    [{ ...headers, origin: "null" }, 403],
  ]) {
    const response = await app.inject({ url: "/api/workflows", headers: requestHeaders });
    assert.equal(response.statusCode, status);
    assert.ok(response.json().requestId);
  }
  assert.equal(calls, 0);
  const response = await app.inject({ url: "/api/workflows", headers: { ...headers, origin: "http://127.0.0.1:7331" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { items: [], limit: 50, offset: 0 });
  assert.equal(calls, 1);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("list endpoint paginates and does not leak repository-only fields", async (t) => {
  const app = setup(t, (limit, offset) => {
    assert.equal(limit, 10); assert.equal(offset, 20);
    return [{ id: "fixture", workspaceId: "workspace", name: "<script>alert(1)</script>", description: "example", status: "active", sourcePath: "/private/file" }];
  });
  const response = await app.inject({ url: "/api/workflows?limit=10&offset=20", headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].sourcePath, undefined);
  for (const query of ["limit=101", "limit=0", "offset=-1", "limit=oops"]) {
    assert.equal((await app.inject({ url: `/api/workflows?${query}`, headers })).statusCode, 400);
  }
});

test("public assets contain no credentials; errors hide internal details", async (t) => {
  const app = setup(t, () => { throw new Error("private-db-path"); });
  for (const url of ["/", "/workbench.js"]) {
    const response = await app.inject({ url, headers: { host: headers.host } });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes(token));
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  }
  const error = await app.inject({ url: "/api/workflows", headers });
  assert.equal(error.statusCode, 500);
  assert.ok(!error.body.includes("private-db-path"));
  assert.throws(() => createServer({ listWorkflows: () => [] }), /access token/);
});
