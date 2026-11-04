import { test } from "node:test";
import assert from "node:assert/strict";
import type { InjectOptions } from "fastify";
import { api, send } from "../src/web/lib/api.js";
import { createApp } from "../src/server/app.js";
import { setup } from "./helpers.js";

test("bodyless Provider detection and model refresh reach the real HTTP handlers", async context => {
  const { store, providers, provider } = setup(context);
  const { app } = createApp(store, providers);
  const originalFetch = globalThis.fetch;
  const requests: { headers: Headers; body: BodyInit | null | undefined }[] = [];
  context.after(async () => { globalThis.fetch = originalFetch; await app.close(); });
  globalThis.fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    requests.push({ headers, body: options?.body });
    const response = await app.inject({
      method: (options?.method ?? "GET") as InjectOptions["method"],
      url: String(url),
      headers: Object.fromEntries(headers),
      ...(options?.body == null ? {} : { payload: String(options.body) }),
    });
    return new Response(response.body, { status: response.statusCode, headers: { "Content-Type": "application/json" } });
  };

  const detection = await send<{ state: string }>(`/providers/${provider.id}/detect`);
  assert.equal(detection.state, "ready");
  const refreshed = await send<{ models: { id: string }[] }>(`/providers/${provider.id}/models/refresh`);
  assert.equal(refreshed.models[0]!.id, "test-model");
  for (const request of requests) {
    assert.equal(request.body, undefined);
    assert.equal(request.headers.has("Content-Type"), false);
  }
});

test("API sets JSON content type only for nonempty payloads and preserves caller headers", async context => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    requests.push(options ?? {});
    return Response.json({ ok: true });
  };

  await api("/providers");
  await api("/empty", { method: "POST", body: "" });
  await send("/settings", { enabled: true });
  await api("/custom", { method: "POST", body: "text", headers: new Headers({ "Content-Type": "text/plain", "X-Custom": "kept" }) });
  await api("/tuple", { method: "POST", body: "{}", headers: [["X-Custom", "tuple"]] });

  assert.equal(new Headers(requests[0]!.headers).has("Content-Type"), false);
  assert.equal(new Headers(requests[1]!.headers).has("Content-Type"), false);
  assert.equal(new Headers(requests[2]!.headers).get("Content-Type"), "application/json");
  assert.equal(new Headers(requests[3]!.headers).get("Content-Type"), "text/plain");
  assert.equal(new Headers(requests[3]!.headers).get("X-Custom"), "kept");
  assert.equal(new Headers(requests[4]!.headers).get("Content-Type"), "application/json");
  assert.equal(new Headers(requests[4]!.headers).get("X-Custom"), "tuple");
});
