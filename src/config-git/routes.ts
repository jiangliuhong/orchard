import type { FastifyInstance } from "fastify";
import { assertSchema } from "../domain/validation.js";
import { check } from "../domain/errors.js";
import type { ConfigGitService } from "./service.js";
import type { SnapshotTheme, SnapshotCategory } from "./snapshot.js";
import type { RestorePreviewOptions } from "./restore.js";
const string = { type: "string", minLength: 1, maxLength: 1000 };
const preference = { theme: { enum: ["light", "dark", "system"] }, clientId: string, preferenceRevision: { type: "integer", minimum: 0 } };
function body<T>(input: unknown, properties: Record<string, unknown> = {}, required: string[] = []): T & Record<string, unknown> {
  const value = input ?? {};
  assertSchema(value, { type: "object", properties: { requestId: { ...string, maxLength: 200 }, ...properties }, required, additionalProperties: false }, "Git 配置请求");
  return value as T & Record<string, unknown>;
}
export function registerConfigGitRoutes(app: FastifyInstance, get: () => ConfigGitService) {
  const root = "/api/config-git";
  const post = (path: string, properties: Record<string, unknown>, required: string[], action: (service: ConfigGitService, value: any) => unknown | Promise<unknown>) => {
    app.post(`${root}${path}`, async (request, reply) => {
      const value = body(request.body, properties, required), service = get();
      return reply.code(202).send(service.run(path, value, () => action(service, value)));
    });
  };
  app.get(`${root}/repository`, async () => ({ binding: await get().repository.getBinding() }));
  app.get(`${root}/status`, async () => get().status());
  post("/remote/check", { remoteUrl: string }, ["remoteUrl"], async (s, v) => {
    const result = await s.repository.checkRemote(v.remoteUrl);
    return { ...result, branches: result.branches.map(item => item.name) };
  });
  post("/bind", { remoteUrl: string, branch: string, configDir: string, identity: { type: "object", properties: { name: string, email: string }, required: ["name", "email"], additionalProperties: false } }, ["remoteUrl", "branch"], (s, v) => s.coordinator.withActivity("git-bind", () => s.repository.bind(v)));
  post("/unbind", {}, [], s => s.coordinator.withActivity("git-unbind", () => s.repository.unbind()));
  post("/fetch", {}, [], s => s.coordinator.withActivity("git-fetch", () => s.repository.fetch()));
  post("/push", {}, [], s => s.coordinator.withActivity("git-push", () => s.repository.push()));
  app.post(`${root}/export`, async request => {
    const value = body<{ theme?: SnapshotTheme }>(request.body, preference);
    return get().export(value.theme);
  });
  post("/commit-preview", { ...preference, message: { ...string, maxLength: 4000 }, push: { type: "boolean" }, regenerate: { type: "boolean" } }, ["message"], (s, v) => s.commitPreview(v));
  post("/commit", { ...preference, token: string }, ["token", "requestId"], (s, v) => s.commit(v));
  app.get<{ Querystring: { scope?: "local" | "remote"; source?: "local" | "remote"; startSha?: string; cursor?: string; offset?: string; limit?: string } }>(`${root}/commits`, async request => {
    const query = request.query;
    check(!query.source || ["local", "remote"].includes(query.source), "INVALID_PAGE", "历史来源无效");
    return get().history({ ...query, cursor: query.cursor ?? query.offset, limit: query.limit === undefined ? undefined : Number(query.limit) });
  });
  post("/restore-preview", { ...preference, categories: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["general", "providers", "webBridge", "scripts", "workflows"] } }, mappings: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 4096 } }, source: { oneOf: [{ type: "object", properties: { kind: { const: "git" }, sha: { type: "string", pattern: "^[a-f0-9]{40}$" } }, required: ["kind", "sha"], additionalProperties: false }, { type: "object", properties: { kind: { const: "recovery-point" }, id: string }, required: ["kind", "id"], additionalProperties: false }] } }, ["source"], (s, v) => s.restorePreview(v as RestorePreviewOptions & { source: NonNullable<RestorePreviewOptions["source"]> }));
  post("/restore", { token: string }, ["token", "requestId"], (s, v) => s.apply(v));
  app.get<{ Params: { token: string }; Querystring: { cursor?: string } }>(`${root}/previews/:token/diffs`, async request => get().previewPage(request.params.token, request.query.cursor));
  app.get(`${root}/recovery-points`, async () => get().recoveryPoints());
  app.delete<{ Params: { id: string } }>(`${root}/recovery-points/:id`, async (request, reply) => {
    const value = body(request.body), s = get();
    return reply.code(202).send(s.run("delete-recovery-point", { ...value, id: request.params.id }, () => { s.restore.deleteRecoveryPoint(request.params.id); return { deleted: true }; }));
  });
  app.get<{ Params: { id: string } }>(`${root}/operations/:id`, async request => {
    const s = get();
    try {
      const operation = s.operations.get(request.params.id);
      if (["/restore", "recover"].includes(operation.kind) && ["failed", "interrupted"].includes(operation.phase)) {
        const restored = s.restore.operations().find(item => item.requestId === operation.requestId);
        if (restored) return { ...operation, phase: restored.phase, result: restored.phase === "completed" ? restored : operation.result, error: restored.error ? { code: "RECOVERY_REQUIRED", message: restored.error } : operation.error };
      }
      return operation;
    } catch { return s.restore.operation(request.params.id); }
  });
  app.post<{ Params: { id: string } }>(`${root}/operations/:id/recover`, async (request, reply) => {
    const value = body(request.body), s = get();
    return reply.code(202).send(s.run("recover", { ...value, id: request.params.id }, async () => {
      let id = request.params.id;
      try { const operation = s.operations.get(id); id = s.restore.operations().find(item => item.requestId === operation.requestId)?.operationId ?? id; } catch {}
      return s.restore.recover(id);
    }));
  });
  app.get<{ Querystring: { clientId?: string } }>(`${root}/general/pending`, async request => {
    const s = get(), clientId = request.query.clientId;
    check(clientId && clientId.length <= 200, "INVALID_CLIENT", "缺少浏览器标识");
    return { items: s.restore.pendingGeneral(clientId).map(item => ({ ...item, preferenceRevision: item.revision })), snapshot: s.restore.getGeneralTheme() ? { theme: s.restore.getGeneralTheme() } : undefined };
  });
  app.post(`${root}/general/claim`, async request => {
    const v = body<{ clientId: string; preferenceRevision: number }>(request.body, preference, ["clientId", "preferenceRevision"]);
    const item = get().restore.claimGeneralSnapshot(v.clientId, v.preferenceRevision);
    return { ...item, preferenceRevision: item.revision };
  });
  app.post(`${root}/general/ack`, async request => {
    const v = body<{ clientId: string; operationId: string; preferenceRevision: number; decision: "apply" | "keep"; force?: boolean }>(request.body, { ...preference, operationId: string, decision: { enum: ["apply", "keep"] }, force: { type: "boolean" } }, ["clientId", "operationId", "preferenceRevision", "decision"]);
    return get().restore.acknowledgeGeneral(v.clientId, v.operationId, v.preferenceRevision, v.decision === "apply" ? "applied" : "kept", v.force);
  });
}
