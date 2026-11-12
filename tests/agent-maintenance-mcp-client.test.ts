import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { MaintenanceMcpClient } from "../src/agent/maintenance-mcp-client.js";
import { RESPONSE_BYTES } from "../src/agent/maintenance-ipc-wire.js";

test("private MCP client serializes requests and accepts fragmented bounded replies", async () => {
  const input = new PassThrough(), output = new PassThrough(), client = new MaintenanceMcpClient(input, output);
  const frame = once(output, "data"), first = client.request("tools/list"), second = client.request("tools/list");
  assert.equal(JSON.parse((await frame)[0].toString()).id, 1);
  const next = once(output, "data");
  input.write('{"jsonrpc":"2.0","id":1,"res'); input.write('ult":{"tools":[]}}\n');
  assert.deepEqual(await first, { tools: [] }); assert.equal(JSON.parse((await next)[0].toString()).id, 2);
  input.write('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n');
  assert.deepEqual(await second, { tools: [] }); await client.close();
});

for (const [name, response] of [
  ["wrong ID", '{"jsonrpc":"2.0","id":999,"result":{}}\n'],
  ["ambiguous response", '{"jsonrpc":"2.0","id":1,"result":{},"error":"PRIVATE_MARKER"}\n'],
  ["malformed UTF-8", Buffer.from([255, 10])],
  ["oversized response", "x".repeat(RESPONSE_BYTES + 1)],
  ["unexpected notification", '{"jsonrpc":"2.0","method":"roots/list"}\n'],
] as const) test(`private MCP client fails closed on ${name} without native diagnostics`, async () => {
  const input = new PassThrough(), output = new PassThrough(), client = new MaintenanceMcpClient(input, output);
  output.resume(); const request = client.request("tools/list");
  const rejected = assert.rejects(request, error => (error as any).code === "MCP_CHANNEL_FAILED" && !String(error).includes("PRIVATE_MARKER"));
  input.write(response); await rejected; await client.close();
  await assert.rejects(client.request("tools/list"), { code: "MCP_CHANNEL_FAILED" });
});

test("private MCP client bounds queued calls and rejects pending calls on broken pipes", async () => {
  const input = new PassThrough(), output = new PassThrough(), client = new MaintenanceMcpClient(input, output); output.resume();
  const requests = Array.from({ length: 8 }, () => client.request("tools/list"));
  const rejected = Promise.all(requests.map(request => assert.rejects(request, { code: "MCP_CHANNEL_FAILED" })));
  await assert.rejects(client.request("tools/list")); input.end(); await rejected; await client.close();
});
