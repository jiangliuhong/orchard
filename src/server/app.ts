import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../persistence/store.js";
import { ProviderRegistry, CliProvider } from "../providers/registry.js";
import { AuthoringService } from "../authoring/service.js";
import { GraphRunner } from "../runtime/runner.js";
import { assertSchema } from "../domain/validation.js";
import { AppError, check } from "../domain/errors.js";
import type { SourceFiles, StreamEvent } from "../domain/types.js";
import { digest, json } from "../persistence/files.js";
import { SCHEMA_VERSION } from "../persistence/schema.js";

const requestId = { type: "string", minLength: 1, maxLength: 200 };
const expectedRevision = { type: "integer", minimum: 0 };
function body<T>(value: unknown, properties: Record<string, unknown>, required: string[]) {
  assertSchema(value, { type: "object", properties, required, additionalProperties: false }, "请求");
  return value as T;
}
function cursor(value: unknown) {
  if (value === undefined) return 0;
  check(typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)), "INVALID_CURSOR", "游标必须为非负整数");
  return Number(value);
}
export function createApp(store: Store, suppliedProviders?: ProviderRegistry) {
  const providers = suppliedProviders ?? new ProviderRegistry(store).register(new CliProvider("codex-cli")).register(new CliProvider("pi-cli"));
  const authoring = new AuthoringService(store, providers), runner = new GraphRunner(store, providers);
  const app = Fastify({ bodyLimit: 6 * 1024 * 1024, logger: false });
  const connections = new Set<() => void>();
  const publicValue = (value: unknown): unknown => {
    const text = json(value);
    if (Buffer.byteLength(text) <= 32768) return value;
    const id = digest(text), artifact = store.one("SELECT byte_size FROM artifacts WHERE id=?", id);
    return artifact ? { artifact: { id, sha256: id, byteSize: Number(artifact.byte_size) } } : value;
  };
  const publicEvent = (event: StreamEvent) => ({ ...event, payload: publicValue(event.payload) });
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    let hostname: string;
    try { hostname = new URL(`http://${host}`).hostname; } catch { return reply.code(403).send({ code: "INVALID_HOST", message: "无效本地 Host" }); }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return reply.code(403).send({ code: "INVALID_HOST", message: "只允许本地工作台访问" });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) return reply.code(403).send({ code: "INVALID_ORIGIN", message: "请求来源与工作台不一致" });
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof AppError;
    const status = known ? /CONFLICT|BUSY|IDENTITY_CHANGED/.test(error.code) ? 409 : error.code === "NOT_FOUND" ? 404 : error.statusCode : (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ code: known ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
  });
  app.get("/api/health", async () => ({ ok: true, application: "orchard-workbench", schemaVersion: SCHEMA_VERSION, activeModelVerifications: providers.activeVerificationCount }));
  app.get("/api/providers", async () => ({ items: providers.views() }));
  app.patch<{ Params: { id: string } }>("/api/providers/:id", async request => providers.update(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/providers/:id/detect", async request => providers.detect(request.params.id));
  app.post<{ Params: { id: string } }>("/api/providers/:id/models/refresh", async request => providers.models(request.params.id));
  app.get<{ Params: { id: string } }>("/api/providers/:id/models", async request => ({
    items: providers.modelList(request.params.id), defaultModel: providers.setting(request.params.id).defaultModel,
  }));
  app.post<{ Params: { id: string } }>("/api/providers/:id/models", async request => providers.addModel(request.params.id, request.body));
  app.patch<{ Params: { id: string; modelId: string } }>("/api/providers/:id/models/:modelId", async request => providers.updateModel(request.params.id, request.params.modelId, request.body));
  app.delete<{ Params: { id: string; modelId: string } }>("/api/providers/:id/models/:modelId", async request => providers.deleteModel(request.params.id, request.params.modelId));
  app.post<{ Params: { id: string; modelId: string } }>("/api/providers/:id/models/:modelId/verify", async (request, reply) => {
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(new AppError("CANCELLED", "客户端已取消验证")); };
    reply.raw.once("close", disconnected);
    try { return await providers.verifyModel(request.params.id, request.params.modelId, { signal: controller.signal }); }
    finally { reply.raw.off("close", disconnected); }
  });
  app.get("/api/drafts", async () => ({ items: store.drafts().map(d => {
    const tree = store.files.readTree(d.artifactPath), definition = JSON.parse(tree.files["workflow.json"]!);
    return { ...d, name: String(definition.name ?? "未命名工作流") };
  }) }));
  app.post("/api/drafts", async request => {
    const input = body<{ workflowId?: string; requestId: string }>(request.body, { workflowId: { type: "string" }, requestId }, ["requestId"]);
    return authoring.create(input.workflowId, input.requestId);
  });
  app.get<{ Params: { id: string } }>("/api/drafts/:id", async request => authoring.snapshot(request.params.id));
  app.delete<{ Params: { id: string } }>("/api/drafts/:id", async request => authoring.deleteDraft(request.params.id));
  app.patch<{ Params: { id: string } }>("/api/drafts/:id", async request => {
    const input = body<{ expectedRevision: number; files: SourceFiles }>(request.body, { expectedRevision, files: { type: "object", additionalProperties: { type: "string" } } }, ["expectedRevision", "files"]);
    return authoring.update(request.params.id, input.expectedRevision, input.files);
  });
  app.post<{ Params: { id: string } }>("/api/drafts/:id/turns", async (request, reply) => {
    const input = body<{ providerId: string; modelId: string; prompt: string; requestId: string; expectedRevision: number }>(request.body, { providerId: { type: "string", minLength: 1 }, modelId: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 }, requestId, expectedRevision }, ["providerId", "modelId", "prompt", "requestId", "expectedRevision"]);
    const result = await authoring.start(request.params.id, input); reply.code(202); return result;
  });
  app.post<{ Params: { id: string; turnId: string } }>("/api/drafts/:id/turns/:turnId/cancel", async request => authoring.cancel(request.params.id, request.params.turnId));
  app.post<{ Params: { id: string } }>("/api/drafts/:id/publish", async request => {
    const input = body<{ expectedRevision: number; requestId: string }>(request.body, { expectedRevision, requestId }, ["expectedRevision", "requestId"]);
    return authoring.publish(request.params.id, input.expectedRevision, input.requestId);
  });
  app.post<{ Params: { id: string } }>("/api/drafts/:id/runs", async (request, reply) => {
    const input = body<{ expectedRevision: number; input: unknown; requestId: string }>(request.body, { expectedRevision, input: {}, requestId }, ["expectedRevision", "input", "requestId"]);
    const result = await runner.createDraft(request.params.id, input.expectedRevision, input.input, input.requestId);
    reply.code(202); return result;
  });
  app.get("/api/workflows", async () => ({ items: store.workflows() }));
  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async request => authoring.deleteWorkflow(request.params.id));
  app.post<{ Params: { id: string } }>("/api/workflows/:id/draft", async request => {
    const input = body<{ versionId?: string; mode: "edit" | "copy" | "restore"; requestId: string }>(request.body, { versionId: { type: "string" }, mode: { enum: ["edit", "copy", "restore"] }, requestId }, ["mode", "requestId"]);
    return authoring.editVersion(request.params.id, input.versionId, input.mode, input.requestId);
  });
  app.get<{ Params: { id: string } }>("/api/workflows/:id", async request => {
    const workflow = store.workflows().find(w => w.id === request.params.id); check(workflow, "NOT_FOUND", "工作流不存在");
    return { ...workflow, versions: store.versions(workflow.id) };
  });
  app.get<{ Params: { id: string; versionId: string } }>("/api/workflows/:id/versions/:versionId", async request => {
    const version = store.version(request.params.versionId); check(version.workflowId === request.params.id, "NOT_FOUND", "版本不属于该工作流");
    return { ...version, files: store.files.readTree(version.artifactPath).files };
  });
  app.post<{ Params: { id: string } }>("/api/workflows/:id/runs", async (request, reply) => {
    const input = body<{ versionId?: string; input: unknown; requestId: string }>(request.body, { versionId: { type: "string" }, input: {}, requestId }, ["input", "requestId"]);
    const workflow = store.workflows().find(w => w.id === request.params.id); check(workflow, "NOT_FOUND", "工作流不存在");
    const version = store.version(input.versionId ?? workflow.currentVersionId); check(version.workflowId === workflow.id, "NOT_FOUND", "版本不属于该工作流");
    const result = runner.create(version.id, input.input, input.requestId); reply.code(202); return result;
  });
  app.get("/api/runs", async () => ({ items: store.runs() }));
  app.get<{ Params: { id: string } }>("/api/runs/:id", async request => {
    const snapshot = runner.snapshot(request.params.id);
    return { ...snapshot, input: publicValue(snapshot.input), output: publicValue(snapshot.output),
      nodes: snapshot.nodes.map(n => ({ ...n, input: publicValue(n.input), output: publicValue(n.output) })),
      attempts: snapshot.attempts.map(a => ({ ...a, input: publicValue(a.input), output: publicValue(a.output) })),
    };
  });
  app.get<{ Params: { id: string } }>("/api/artifacts/:id", async request => {
    const artifact = store.one("SELECT * FROM artifacts WHERE id=?", request.params.id);
    check(artifact, "NOT_FOUND", "产物不存在");
    return store.files.readBlob(String(artifact.relative_path), String(artifact.sha256), Number(artifact.byte_size));
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async request => runner.cancel(request.params.id));
  for (const [resource, type] of [["runs", "run"], ["turns", "authoring_turn"]] as const) {
    app.get<{ Params: { id: string }; Querystring: { after?: string } }>(`/api/${resource}/:id/events`, async request => {
      if (type === "run") store.run(request.params.id); else store.turn(request.params.id);
      return { items: store.stream(type, request.params.id, cursor(request.query.after)).map(publicEvent), lastSequence: store.lastSequence(type, request.params.id) };
    });
    app.get<{ Params: { id: string }; Querystring: { after?: string } }>(`/api/${resource}/:id/stream`, async (request, reply) => {
      const id = request.params.id;
      if (type === "run") store.run(id); else store.turn(id);
      let after = cursor(request.headers["last-event-id"] ?? request.query.after), closed = false;
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const cleanup = () => {
        if (closed) return; closed = true;
        clearInterval(heartbeat); store.events.off("event", listener); connections.delete(cleanup); reply.raw.end();
      };
      const pump = () => {
        if (closed) return;
        let rows: StreamEvent[];
        do {
          rows = store.stream(type, id, after);
          for (const event of rows) {
            if (!reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(publicEvent(event))}\n\n`)) { cleanup(); return; }
            after = event.sequence;
          }
        } while (rows.length === 500);
      };
      const listener = (event: StreamEvent) => { if (event.streamType === type && event.streamId === id) { try { pump(); } catch { cleanup(); } } };
      const heartbeat = setInterval(() => { if (!reply.raw.write(": heartbeat\n\n")) cleanup(); }, 15000);
      heartbeat.unref(); connections.add(cleanup); store.events.on("event", listener);
      reply.raw.on("close", cleanup);
      try { pump(); } catch { cleanup(); }
    });
  }
  const assets = fileURLToPath(new URL("../../dist/web", import.meta.url));
  if (existsSync(assets)) {
    app.register(staticPlugin, { root: assets });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ code: "NOT_FOUND", message: "接口不存在" }) : reply.sendFile("index.html"));
  }
  app.addHook("preClose", async () => { for (const close of connections) close(); await providers.closeVerifications(); });
  app.addHook("onClose", async () => { await authoring.close(); await runner.close(); store.close(); });
  return { app, store, providers, authoring, runner };
}
