import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { writeJson } from "../migrations/journal.js";
import { canonicalJson } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import type { QuickLaunchService } from "../quick-launch/service.js";
import { cardId, policyFile, readPolicy, validatePolicy, type Channel, type Grant } from "./policy.js";

const installation = (root: string, port: number) => {
  const development = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(development ? "../cli/index.ts" : "../cli/index.js", import.meta.url));
  const launcher = development ? ["--import", import.meta.resolve("tsx"), cli] : [cli];
  return { command: process.execPath, args: [...launcher, "quick-launch", "--stdio", "--data-dir", root, "--port", String(port)] };
};

export function registerAgentAccess(app: FastifyInstance, store: Store, quick: QuickLaunchService,
  authorized: (token: unknown) => boolean, port: number) {
  const cards = () => quick.list().items.flatMap(({ id, name, note, revision, target, available, confirmation }) =>
    target.kind === "workflow" ? [] : [{ id, name, note, revision, kind: target.kind, available, confirmation }]);
  const view = () => ({ policy: readPolicy(store.root), cards: cards(), installation: installation(store.root, port) });
  const eligible = (card: Pick<ReturnType<QuickLaunchService["get"]>, "available" | "confirmation">) => card.available && !card.confirmation;
  const matches = (grant: Grant, card: Grant) => grant.id === card.id && grant.revision === card.revision;
  app.get("/api/settings/agent-access", (_request, reply) => reply.header("Cache-Control", "no-store").send(view()));
  app.put("/api/settings/agent-access", (request, reply) => {
    const next = validatePolicy(request.body), current = readPolicy(store.root);
    check(next.revision === current.revision, "REVISION_CONFLICT", "权限已被修改，请刷新后重试", 409);
    const candidates = cards();
    for (const channel of ["mcp", "cli"] as const) {
      const seen = new Set<string>();
      for (const grant of next[channel].cards) {
        check(!seen.has(grant.id), "INVALID_REQUEST", "同一入口不能重复授权卡片");
        seen.add(grant.id);
        check(current[channel].cards.some(prior => matches(prior, grant)) ||
          candidates.some(card => matches(grant, card) && eligible(card)),
        "CARD_UNAVAILABLE", "只能授权可用且无需逐次确认的卡片", 409);
      }
    }
    writeJson(policyFile(store.root), { ...next, revision: current.revision + 1 });
    return reply.header("Cache-Control", "no-store").send(view());
  });

  app.register(async scoped => {
    scoped.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      check(authorized(request.headers["x-orchard-token"]), "UNAUTHORIZED", "需要本机 API 凭据", 401);
    });
    const access = (channel: Channel) => {
      check(channel === "mcp" || channel === "cli", "NOT_FOUND", "入口不存在", 404);
      const permission = readPolicy(store.root)[channel];
      check(permission.enabled, "AGENT_ACCESS_DISABLED", "请在 Orchard 设置中启用此入口", 403);
      return permission;
    };
    const allowed = (channel: Channel) => {
      const permission = access(channel);
      return cards().filter(card => eligible(card) && permission.cards.some(grant => matches(grant, card)));
    };
    type Params = { channel: Channel; id: string };
    scoped.get<{ Params: Params }>("/api/agent-access/:channel/tools", request => ({ items: allowed(request.params.channel) }));
    scoped.post<{ Params: Params }>("/api/agent-access/:channel/tools/:id", (request, reply) => {
      const { channel, id } = request.params;
      assertSchema(request.body, { type: "object", required: ["revision"], additionalProperties: false, properties: {
        revision: { type: "integer", minimum: 1 }, requestId: { type: "string", pattern: cardId.pattern },
      } }, "Agent 执行请求");
      const input = request.body as { revision: number; requestId?: string };
      check(allowed(channel).some(card => matches({ id, revision: input.revision }, card)),
        "TOOL_UNAVAILABLE", "卡片未开放、已变更或不可用", 403);
      const run = quick.start(id, { revision: input.revision, requestId: input.requestId ?? randomUUID() }, channel);
      return reply.code(202).send(quick.agentResult(channel, run.id));
    });
    scoped.post("/api/agent-access/cli/legacy-web-bridge", (request, reply) => {
      const shortText = { type: "string", minLength: 1, maxLength: 200 };
      assertSchema(request.body, { type: "object", additionalProperties: false,
        required: ["application", "tool", "args", "requestId"],
        properties: { application: shortText, tool: shortText, args: {}, environmentId: shortText, requestId: cardId },
      }, "CLI 网页工具请求");
      const input = request.body as { application: string; tool: string; args: unknown; environmentId?: string; requestId: string };
      const compatible = allowed("cli").filter(card => card.kind === "browser_tool").map(card => quick.get(card.id))
        .filter(({ target, fixedInput, inputSources }) => target.kind === "browser_tool" && target.applicationId === input.application &&
          target.toolId === input.tool && (!input.environmentId || target.environmentId === input.environmentId) &&
          !Object.keys(inputSources).length && canonicalJson(fixedInput) === canonicalJson(input.args));
      check(compatible.length === 1, "TOOL_UNAVAILABLE", "没有唯一匹配且向 CLI 开放的卡片，请用 orchard quick-launch list 查找卡片", 403);
      const [card] = compatible;
      const run = quick.start(card.id, { revision: card.revision, requestId: input.requestId }, "cli");
      return reply.code(202).send(quick.agentResult("cli", run.id));
    });
    scoped.get<{ Params: Params }>("/api/agent-access/:channel/executions/:id", request => {
      const { channel, id } = request.params;
      const permission = access(channel);
      const grant = quick.agentGrant(channel, id);
      const card = quick.get(grant.id);
      check(permission.cards.some(item => matches(item, grant)) && matches(card, grant) && eligible(card),
        "TOOL_UNAVAILABLE", "运行对应的卡片已变更或取消授权", 403);
      return quick.agentResult(channel, id);
    });
  });
}
