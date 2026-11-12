import { randomBytes } from "node:crypto";
import { AppError, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { canonicalJson } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import { assertTarget, MAINTENANCE_CONTRACT, type MaintenanceTarget } from "./maintenance-protocol.js";
import type { MaintenanceService } from "./maintenance-service.js";
import { projectionState } from "./workspace-state.js";
import type { ScopedWorkspaceReader } from "./workspace-files.js";
import { requireWorkspaceBusinessTracking } from "./workspace-business-hooks.js";

interface Grant {
  actor: string; sessionId: string; taskId: string; generation: number; target: MaintenanceTarget;
  projectionGeneration: number; projectionHash: string; baseline: unknown; expiresAt: number; signal: AbortSignal; revoke(): void;
}
const id = { type: "string", minLength: 1, maxLength: 200 };
const publicErrorCodes = new Set(["METHOD_NOT_FOUND", "MCP_NOT_INITIALIZED", "TOOL_INPUT_TOO_LARGE", "INVALID_REQUEST", "SCHEMA_MISMATCH", "TOOL_AUTHORIZATION_REVOKED", "MAINTENANCE_AUTHORIZATION_REVOKED", "FORBIDDEN", "CONFIRMATION_REQUIRED", "OWNER_UNAVAILABLE", "REVISION_CONFLICT", "PROPOSAL_TARGET_MISMATCH", "PROPOSAL_BUDGET_EXCEEDED", "QUERY_SENSITIVE_CONTENT", "TOOL_DENIED", "TOOL_RESULT_TOO_LARGE"]);
const publicError = (error: unknown, fallback: string) => error instanceof AppError && publicErrorCodes.has(error.code) ? error.code : fallback;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
export type MaintenanceToolName = "submit_proposal" | "apply_proposal" | "proposal_status";

/** Short-lived execution authority. The token never appears in tool arguments,
 * responses, files, SQL, native transcripts or command-line arguments. */
export class MaintenanceToolGateway {
  private readonly grants = new Map<string, Grant>();
  constructor(private readonly store: Store, private readonly service: MaintenanceService, private readonly now = Date.now) {}
  issue(input: { actor: string; sessionId: string; taskId: string; signal: AbortSignal; ttlMs?: number }) {
    input.signal.throwIfAborted();
    for (const grant of this.grants.values()) if (grant.expiresAt <= this.now() || grant.signal.aborted) grant.revoke();
    const ttl = input.ttlMs ?? 30 * 60_000;
    check(Number.isSafeInteger(ttl) && ttl >= 1 && ttl <= 30 * 60_000 && this.grants.size < 128, "TOOL_AUTHORIZATION_INVALID", "工具授权预算无效", 403);
    const session = this.store.one<{ actor_key: string; owner_kind: MaintenanceTarget["kind"]; owner_id: string; owner_scope_json: string; lifecycle: string; generation: number }>("SELECT * FROM agent_maintenance_sessions WHERE id=? AND actor_key=?", input.sessionId, input.actor);
    const task = this.store.one<{ generation: number; projection_generation: number; projection_hash: string; baseline_json: string; status: string }>("SELECT * FROM agent_maintenance_tasks WHERE id=? AND session_id=?", input.taskId, input.sessionId);
    check(session && task && session.lifecycle === "active" && task.generation === session.generation && ["queued", "running"].includes(task.status), "TOOL_AUTHORIZATION_REVOKED", "维护任务不可授权", 403);
    const target = { kind: session.owner_kind, id: session.owner_id, scope: JSON.parse(session.owner_scope_json) } as MaintenanceTarget; assertTarget(target);
    const token = randomBytes(32).toString("base64url"), cancellation = new AbortController();
    const revoke = () => { this.grants.delete(token); input.signal.removeEventListener("abort", revoke); cancellation.abort(); };
    const grant: Grant = { actor: input.actor, sessionId: input.sessionId, taskId: input.taskId, generation: task.generation, target,
      projectionGeneration: task.projection_generation, projectionHash: task.projection_hash, baseline: JSON.parse(task.baseline_json), expiresAt: this.now() + ttl, signal: cancellation.signal, revoke };
    this.grants.set(token, grant); input.signal.addEventListener("abort", revoke, { once: true });
    try { this.validate(token); } catch (error) { revoke(); throw error; }
    return { token, revoke, signal: cancellation.signal };
  }
  /** Internal file/IPC gate. Never returns or serializes the grant. */
  assertActive(token: string): void { this.validate(token); }
  assertReader(token: string, reader: ScopedWorkspaceReader): void {
    requireWorkspaceBusinessTracking(this.store); reader.assertIdentity(this.validate(token).projectionHash);
  }
  revokeTask(taskId: string) { for (const grant of this.grants.values()) if (grant.taskId === taskId) grant.revoke(); }
  private validate(token: string): Grant {
    const grant = this.grants.get(token);
    if (grant && (grant.expiresAt <= this.now() || grant.signal.aborted)) grant.revoke();
    check(grant && this.grants.get(token) === grant && grant.expiresAt > this.now() && !grant.signal.aborted, "TOOL_AUTHORIZATION_REVOKED", "工具授权无效或已过期", 403);
    const task = this.store.one<{ status: string; generation: number }>("SELECT status,generation FROM agent_maintenance_tasks WHERE id=? AND session_id=?", grant.taskId, grant.sessionId);
    const session = this.store.one<{ generation: number; lifecycle: string; actor_key: string }>("SELECT generation,lifecycle,actor_key FROM agent_maintenance_sessions WHERE id=?", grant.sessionId);
    const state = projectionState(this.store);
    check(task && ["queued", "running"].includes(task.status) && task.generation === grant.generation && session?.generation === grant.generation && session.lifecycle === "active" && session.actor_key === grant.actor && state.state === "ready" && state.target_generation === grant.projectionGeneration && state.synced_generation === grant.projectionGeneration && state.content_hash === grant.projectionHash,
      "TOOL_AUTHORIZATION_REVOKED", "任务、代次或投影已经变化", 403);
    this.service.authorizeTaskRead(grant.actor, grant.sessionId, grant.taskId);
    if (grant.expiresAt <= this.now()) grant.revoke();
    check(this.grants.get(token) === grant && !grant.signal.aborted, "TOOL_AUTHORIZATION_REVOKED", "维护权限检查期间授权已撤销", 403);
    return grant;
  }
  tools(token: string) {
    const grant = this.validate(token);
    return [
      { name: "submit_proposal", description: "提交固定目标的不可变候选变更并生成 diff；不应用、不确认、不发布。", inputSchema: object({
        contractVersion: { const: MAINTENANCE_CONTRACT }, requestId: id, summary: { type: "string", minLength: 1, maxLength: 4000 }, target: { const: JSON.parse(canonicalJson(grant.target)) }, baseline: { const: JSON.parse(canonicalJson(grant.baseline)) }, change: { type: "object" },
      }), annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false } },
      { name: "apply_proposal", description: "登记已获真实用户确认的提案应用请求；活动轮次仅返回 queued，停止读取后平台统一应用。", inputSchema: object({ proposalId: id, requestId: id }), annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false } },
      { name: "proposal_status", description: "查询本对话提案状态，不重放历史、不触发模型或业务执行。", inputSchema: object({ proposalId: id }), annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false } },
    ];
  }
  async call(token: string, name: string, args: unknown) {
    const grant = this.validate(token), tool = this.tools(token).find(tool => tool.name === name);
    check(tool, "TOOL_DENIED", "工具不在维护 allowlist 中", 403);
    check(Buffer.byteLength(canonicalJson(args)) <= 8 * 1024 * 1024, "TOOL_INPUT_TOO_LARGE", "工具参数超限");
    assertSchema(args, tool.inputSchema, "维护工具参数");
    const value = args as { proposalId?: string; requestId?: string };
    if (name !== "submit_proposal") {
      const proposal = this.store.one<{ session_id: string; target_kind: string; target_id: string; target_scope_json: string }>("SELECT session_id,target_kind,target_id,target_scope_json FROM agent_maintenance_proposals WHERE id=? AND actor_key=?", value.proposalId!, grant.actor);
      check(proposal && proposal.session_id === grant.sessionId && canonicalJson({ kind: proposal.target_kind, id: proposal.target_id, scope: JSON.parse(proposal.target_scope_json) }) === canonicalJson(grant.target), "PROPOSAL_TARGET_MISMATCH", "提案不属于当前对话和固定维护对象", 403);
    }
    let result: unknown;
    if (name === "submit_proposal") {
      const proposal = await this.service.submit(grant.actor, grant.sessionId, grant.taskId, args, grant.signal);
      result = { proposalId: proposal.id, state: proposal.state, contentHash: proposal.contentHash, diffHash: proposal.diffHash };
    } else if (name === "apply_proposal") result = this.service.enqueue(grant.actor, value.proposalId!, value.requestId!);
    else {
      const proposal = this.service.view(grant.actor, value.proposalId!);
      result = { proposalId: proposal.id, target: proposal.target, state: proposal.state, summary: proposal.summary,
        applications: this.store.all<{ id: string }>("SELECT id FROM agent_maintenance_apply_requests WHERE proposal_id=? AND actor_key=? ORDER BY created_at DESC LIMIT 10", proposal.id, grant.actor).map(row => this.service.receipt(grant.actor, row.id)) };
    }
    check(this.validate(token) === grant, "TOOL_AUTHORIZATION_REVOKED", "工具调用完成前授权已撤销", 403);
    this.service.assertToolResultSafe(result);
    check(Buffer.byteLength(canonicalJson(result)) <= 65536, "TOOL_RESULT_TOO_LARGE", "工具结果超限");
    return result;
  }
}

/** Protocol handler for a platform-owned stdio bridge. Authentication is an
 * out-of-band constructor capability, never a client-declared actor/confirmed flag.
 * No generic MCP resources, SQL, filesystem or confirmation methods exist here. */
export class MaintenanceMcpConnection {
  private initialized = false;
  constructor(private readonly gateway: MaintenanceToolGateway, private readonly token: string) {}
  async handle(record: unknown): Promise<unknown> {
    let requestId: string | number | null = null;
    try {
      check(Buffer.byteLength(canonicalJson(record)) <= 9 * 1024 * 1024, "TOOL_INPUT_TOO_LARGE", "MCP 记录超限");
      check(record && typeof record === "object" && !Array.isArray(record), "INVALID_REQUEST", "MCP 请求无效");
      const request = record as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
      check(request.jsonrpc === "2.0" && typeof request.method === "string", "INVALID_REQUEST", "MCP 请求无效");
      if (request.id === undefined) { if (request.method === "notifications/initialized") return undefined; return undefined; }
      check(typeof request.id === "string" || (typeof request.id === "number" && Number.isFinite(request.id)), "INVALID_REQUEST", "MCP 请求 ID 无效"); requestId = request.id;
      let result: unknown;
      if (request.method === "initialize") {
        assertSchema(request.params, { ...object({ protocolVersion: { type: "string" }, capabilities: { type: "object" }, clientInfo: { type: "object" }, _meta: { type: "object" } }, ["protocolVersion", "capabilities", "clientInfo"]) }, "MCP 初始化");
        const requested = (request.params as { protocolVersion: string }).protocolVersion;
        const protocolVersion = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(requested) ? requested : "2025-11-25";
        this.gateway.tools(this.token); this.initialized = true;
        result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "orchard-maintenance", version: "1" } };
      } else {
        check(this.initialized, "MCP_NOT_INITIALIZED", "MCP 尚未初始化");
        if (request.method === "ping") { this.gateway.tools(this.token); result = {}; }
        else if (request.method === "tools/list") result = { tools: this.gateway.tools(this.token) };
        else if (request.method === "tools/call") {
          assertSchema(request.params, object({ name: { type: "string", maxLength: 100 }, arguments: { type: "object" }, _meta: { type: "object" } }, ["name", "arguments"]), "MCP 工具请求");
          const params = request.params as { name: string; arguments: unknown };
          try {
            const value = await this.gateway.call(this.token, params.name, params.arguments);
            result = { content: [{ type: "text", text: canonicalJson(value) }], structuredContent: value, isError: false };
          } catch (error) {
            const code = publicError(error, "TOOL_FAILED");
            result = { content: [{ type: "text", text: canonicalJson({ code, message: "维护工具调用未完成，请查看平台状态" }) }], isError: true };
          }
        } else throw new AppError("METHOD_NOT_FOUND", "不支持的 MCP 方法");
      }
      check(Buffer.byteLength(canonicalJson(result)) <= 65536, "TOOL_RESULT_TOO_LARGE", "MCP 结果超限");
      return { jsonrpc: "2.0", id: requestId, result };
    } catch (error) {
      return { jsonrpc: "2.0", id: requestId, error: { code: error instanceof AppError && error.code === "METHOD_NOT_FOUND" ? -32601 : -32600, message: publicError(error, "MCP_FAILED") } };
    }
  }
}
