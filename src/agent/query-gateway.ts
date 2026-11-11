import { randomBytes } from "node:crypto";
import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { canonicalJson } from "../persistence/files.js";
import { KNOWLEDGE_CONTRACT_VERSION, KNOWLEDGE_TOOL_POLICY_VERSION, PLATFORM_READ_TOOL_NAMES } from "./knowledge-bundle.js";
import type { AgentStore, ConversationRow } from "./store.js";

export type AssetKind = "workflow" | "script" | "bridge_tool";
export interface AssetSelector { kind: AssetKind; id: string; version?: string }
export interface AssetSummary extends AssetSelector { name: string; revision: string }
export interface AssetSnapshot extends AssetSummary {
  definition: unknown;
  validation?: { valid: boolean; diagnostics: string[] };
  /** Resource-relative logical files, never host paths. */
  files: Readonly<Record<string, string>>;
}
export interface AssetReference { source: AssetSelector; target: AssetSelector }
export interface ReferencePage { items: AssetReference[]; nextCursor: string | null; incomplete?: boolean; incompleteSources?: AssetSelector[]; incompleteSourceCount?: number }
/** Virtual resource file, never resolved against the host filesystem. */
export const DEFINITION_FILE = "$definition.json";
export interface QueryContext { actor: string; conversation: ConversationRow; turnId: string; generation: number }
export interface PlatformQueryHost {
  /** Recheck owner and the current local identity boundary on EVERY call. */
  authorize(context: QueryContext, resource?: AssetSelector): Promise<void>;
  search(context: QueryContext, input: { kind?: AssetKind; query: string; cursor?: string; limit: number }): Promise<{ items: AssetSummary[]; nextCursor: string | null }>;
  get(context: QueryContext, resource: AssetSelector): Promise<AssetSnapshot>;
  current(context: QueryContext): Promise<AssetSnapshot>;
  references(context: QueryContext, resource: AssetSelector, cursor: string | undefined, limit: number): Promise<ReferencePage>;
  /** Only the server-selected test for this fixed owner; no client-supplied testId. */
  selectedTest(context: QueryContext): Promise<unknown>;
  /** Include known local credentials as well as the platform's field/source detector. */
  assertSafe(value: unknown): void;
}

const id = { type: "string", minLength: 1, maxLength: 200 };
const kind = { enum: ["workflow", "script", "bridge_tool"] };
const selector = { kind, id, version: id };
const pagination = { cursor: { type: "string", minLength: 1, maxLength: 1000 }, limit: { type: "integer", minimum: 1, maximum: 50 } };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const PLATFORM_QUERY_SCHEMAS = Object.freeze({
  "assets.search": object({ kind, query: { type: "string", maxLength: 200 }, ...pagination }),
  "workflows.get": object({ id, version: id }, ["id"]),
  "scripts.get": object({ id, version: id }, ["id"]),
  "bridge_tools.get": object({ id, version: id }, ["id"]),
  "assets.read_file": object({ ...selector, path: { type: "string", minLength: 1, maxLength: 240 }, startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 200 }, offset: { type: "integer", minimum: 0 }, maxChars: { type: "integer", minimum: 1, maximum: 8192 } }, ["kind", "id", "path"]),
  "assets.references": object({ ...selector, ...pagination }, ["kind", "id"]),
  "current.get": object({}),
  "current.selected_test": object({}),
});
export type PlatformQueryName = keyof typeof PLATFORM_QUERY_SCHEMAS;
interface Grant { context: QueryContext; expiresAt: number; signal: AbortSignal; revoke(): void }

/** In-memory, short-lived execution authority. Credentials are never stored in cwd,
 * messages, DTOs or the database. Provider transports receive only their own grant.
 */
export class PlatformQueryGateway {
  private readonly grants = new Map<string, Grant>();
  constructor(private readonly store: AgentStore, private readonly host: PlatformQueryHost, private readonly now = Date.now) {}

  issue(input: { actor: string; conversationId: string; turnId: string; generation: number; signal: AbortSignal; ttlMs?: number }) {
    const ttl = input.ttlMs ?? 120_000;
    check(Number.isInteger(ttl) && ttl > 0 && ttl <= 600_000, "INVALID_REQUEST", "查询授权有效期无效");
    input.signal.throwIfAborted();
    for (const grant of this.grants.values()) if (grant.signal.aborted || grant.expiresAt <= this.now()) grant.revoke();
    const conversation = this.store.conversation(input.actor, input.conversationId);
    const context = { actor: input.actor, conversation, turnId: input.turnId, generation: input.generation };
    this.validate(context);
    const token = randomBytes(32).toString("base64url");
    const revoke = () => { this.grants.delete(token); input.signal.removeEventListener("abort", revoke); };
    this.grants.set(token, { context, signal: input.signal, expiresAt: this.now() + ttl, revoke });
    input.signal.addEventListener("abort", revoke, { once: true });
    return { token, revoke };
  }
  revokeConversation(id: string) {
    for (const grant of this.grants.values()) if (grant.context.conversation.id === id) grant.revoke();
  }
  close() { for (const grant of this.grants.values()) grant.revoke(); }

  private validate(context: QueryContext): QueryContext {
    const conversation = this.store.conversation(context.actor, context.conversation.id);
    const turn = this.store.turn(context.actor, context.turnId);
    check(conversation.mode === "multi" && ["workflow", "script", "web-bridge"].includes(conversation.scenario) &&
      conversation.lifecycle === "active" && conversation.usability === "usable" &&
      conversation.contract_version === KNOWLEDGE_CONTRACT_VERSION && conversation.tool_policy_version === KNOWLEDGE_TOOL_POLICY_VERSION &&
      turn.conversation_id === conversation.id && turn.status === "running" && turn.generation === context.generation &&
      this.store.backend(context.actor, conversation.id)?.generation === context.generation,
    "QUERY_AUTHORIZATION_REVOKED", "查询授权已失效", 403);
    return { ...context, conversation };
  }

  async call(token: string, name: string, args: unknown): Promise<unknown> {
    const grant = this.grants.get(token);
    if (grant && (grant.signal.aborted || grant.expiresAt <= this.now())) grant.revoke();
    check(grant && this.grants.has(token), "QUERY_UNAUTHORIZED", "查询授权不存在或已过期", 403);
    check(Object.hasOwn(PLATFORM_QUERY_SCHEMAS, name), "QUERY_TOOL_FORBIDDEN", "不允许调用此平台工具", 403);
    const tool = name as PlatformQueryName;
    assertSchema(args, PLATFORM_QUERY_SCHEMAS[tool], "查询参数");
    const input = args as Record<string, string | number | undefined>;
    const context = this.validate(grant.context);
    const resource = ["workflows.get", "scripts.get", "bridge_tools.get"].includes(tool)
      ? { kind: ({ "workflows.get": "workflow", "scripts.get": "script", "bridge_tools.get": "bridge_tool" } as Record<string, AssetKind>)[tool]!, id: input.id as string, ...(input.version ? { version: input.version as string } : {}) }
      : ["assets.read_file", "assets.references"].includes(tool) ? { kind: input.kind as AssetKind, id: input.id as string, ...(input.version ? { version: input.version as string } : {}) } : undefined;
    await this.host.authorize(context, resource);
    let result: unknown;
    let baseline: string | undefined;
    if (tool === "assets.search") {
      const page = await this.host.search(context, { kind: input.kind as AssetKind | undefined, query: input.query as string ?? "", cursor: input.cursor as string | undefined, limit: input.limit as number ?? 20 });
      check(page.items.length <= ((input.limit as number | undefined) ?? 20), "QUERY_RESULT_INVALID", "列表超过请求分页大小");
      for (const item of page.items) await this.host.authorize(context, item);
      result = page;
    } else if (tool === "assets.references") {
      const page = await this.host.references(context, resource!, input.cursor as string | undefined, input.limit as number ?? 20);
      check(page.items.length <= ((input.limit as number | undefined) ?? 20), "QUERY_RESULT_INVALID", "引用超过请求分页大小");
      for (const item of page.items) { await this.host.authorize(context, item.source); await this.host.authorize(context, item.target); }
      for (const item of page.incompleteSources ?? []) await this.host.authorize(context, item);
      result = page;
    } else if (tool === "current.selected_test") result = await this.host.selectedTest(context);
    else {
      const snapshot = tool === "current.get" ? await this.host.current(context) : await this.host.get(context, resource!);
      await this.host.authorize(context, snapshot);
      if (resource) check(snapshot.kind === resource.kind && snapshot.id === resource.id && (!resource.version || snapshot.version === resource.version), "QUERY_RESULT_INVALID", "查询结果与指定资源/版本不一致");
      // Scan the ENTIRE resource before slicing; splitting lines must not bypass detection.
      this.host.assertSafe(snapshot);
      const definitionText = JSON.stringify(snapshot.definition, null, 2);
      const files: Record<string, string> = { ...snapshot.files, [DEFINITION_FILE]: definitionText };
      if (tool === "assets.read_file") {
        const path = input.path as string;
        check(!path.includes("\\") && !path.startsWith("/") && !path.split("/").some(part => !part || part === "." || part === ".."), "INVALID_SOURCE_PATH", "只允许资源内的规范相对路径");
        check(Object.hasOwn(files, path), "NOT_FOUND", "资源文件不存在", 404);
        if (input.offset !== undefined || input.maxChars !== undefined) {
          check(input.startLine === undefined && input.lineCount === undefined, "INVALID_REQUEST", "字符分页不能与行分页混用");
          const characters = Array.from(files[path]!);
          const offset = (input.offset as number | undefined) ?? 0, count = (input.maxChars as number | undefined) ?? 8192;
          check(Number.isSafeInteger(offset) && offset <= characters.length, "INVALID_REQUEST", "字符游标无效");
          const content = characters.slice(offset, offset + count).join("");
          const nextOffset = offset + count < characters.length ? offset + count : null;
          result = { kind: snapshot.kind, id: snapshot.id, version: snapshot.version, revision: snapshot.revision, path, offset, content, nextOffset, truncated: nextOffset !== null };
        } else {
          const lines = files[path]!.split("\n");
          const start = input.startLine as number ?? 1, count = input.lineCount as number ?? 100;
          check(Number.isSafeInteger(start) && start <= lines.length + 1, "INVALID_REQUEST", "源码行游标无效");
          const selected: string[] = [];
          let bytes = 0;
          for (const line of lines.slice(start - 1, start - 1 + count)) {
            const size = Buffer.byteLength(line) + 1;
            check(size <= 32_768, "QUERY_SOURCE_LINE_TOO_LARGE", "源码单行超限，无法安全分页");
            if (bytes + size > 32_768) break;
            selected.push(line); bytes += size;
          }
          const next = start - 1 + selected.length < lines.length ? start + selected.length : null;
          result = { kind: snapshot.kind, id: snapshot.id, version: snapshot.version, revision: snapshot.revision, path, startLine: start, content: selected.join("\n"), nextLine: next, truncated: next !== null };
        }
      } else {
        // Always return a bounded revision/metadata response for current.get.
        // Other get tools retain inline definitions when small; large definitions
        // are explicitly omitted and remain fully readable via the virtual file.
        const definitionIncluded = tool !== "current.get" && Buffer.byteLength(canonicalJson(snapshot.definition)) <= 32_768;
        result = { kind: snapshot.kind, id: snapshot.id, name: snapshot.name, version: snapshot.version, revision: snapshot.revision,
          ...(definitionIncluded ? { definition: snapshot.definition } : {}), ...(snapshot.validation ? { validation: snapshot.validation } : {}), definitionIncluded, definitionFile: DEFINITION_FILE,
          files: Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), lines: content.split("\n").length })), sourceIncluded: false };
        if (tool === "current.get") baseline = snapshot.revision;
      }
    }
    this.host.assertSafe(result);
    check(Buffer.byteLength(canonicalJson(result)) <= 65_536, "QUERY_RESULT_TOO_LARGE", "查询结果超限，请分页或分文件读取");
    // Awaited I/O can outlive cancellation, permissions or a knowledge upgrade.
    check(this.grants.get(token) === grant && grant.expiresAt > this.now() && !grant.signal.aborted, "QUERY_AUTHORIZATION_REVOKED", "查询授权已失效", 403);
    const latest = this.validate(context);
    await this.host.authorize(latest, resource);
    check(this.grants.get(token) === grant && grant.expiresAt > this.now() && !grant.signal.aborted, "QUERY_AUTHORIZATION_REVOKED", "查询授权已失效", 403);
    this.validate(latest);
    if (baseline !== undefined) this.store.recordCurrentRead(context.actor, context.turnId, context.generation, baseline);
    return result;
  }
}

/** Conservative deny policy, matching the existing configuration-diff policy.
 * False positives are explicit failures, never silently 'complete' redacted source.
 * Known values must be supplied by the local host, not by the model.
 */
export function assertQuerySafe(value: unknown, knownSecrets: readonly string[] = []): void {
  const text = canonicalJson(value);
  check(!/(?:encryptedValue|api[_-]?key|password|passwd|secret|authorization|bearer\s|private[_-]?key|access[_-]?token|refresh[_-]?token|["']?token["']?\s*[:=]|https?:\/\/[^\s/]+:[^\s/]+@)/i.test(text) &&
    !knownSecrets.some(secret => secret.length > 0 && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))), "QUERY_SENSITIVE_CONTENT", "查询结果可能包含敏感内容，已阻止返回", 403);
}

// Keep the public tool contract aligned with the packaged declaration.
check(PLATFORM_READ_TOOL_NAMES.every(name => Object.hasOwn(PLATFORM_QUERY_SCHEMAS, name)), "QUERY_CONTRACT_INVALID", "平台工具声明不一致");
