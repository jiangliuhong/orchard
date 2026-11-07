import { randomUUID } from "node:crypto";
import { AppError, check } from "../domain/errors.js";
import type { ConversationMode, ConversationView } from "../domain/types.js";
import { transportOf, type ProviderRegistry } from "../providers/registry.js";
import { connectionFingerprint } from "../providers/session.js";
import { Store, type ConversationRecord } from "../persistence/store.js";

export interface ConversationSelection {
  providerId: string;
  modelId: string;
  mode?: ConversationMode;
  conversationId?: string | null;
  rebuildFromId?: string | null;
}

/** 标题/摘要的确定性规则（history-schema-proposal §4.3）：压平空白后按 Unicode 码点截断。 */
export function excerpt(text: string, limit: number): string {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  const chars = Array.from(normalized);
  return chars.length <= limit ? normalized : chars.slice(0, limit).join("") + "…";
}
export const titleFromPrompt = (prompt: string) => excerpt(prompt, 80);
const summaryFromMessage = (text: string) => excerpt(text, 120);

/** 逻辑对话生命周期与历史状态机；不启动后端进程、不包含 backend ref 到公开返回值。 */
export class ConversationService {
  constructor(readonly store: Store, readonly providers: ProviderRegistry) {}

  view(id: string, connectionState: ConversationView["connectionState"] = "absent") {
    const record = this.store.conversation(id);
    check(record, "NOT_FOUND", "会话不存在", 404);
    return this.toView(record, undefined, connectionState);
  }

  /** 列表按最近活动时间倒序；currentId 为草稿当前对话（仅 current 状态）。 */
  list(draftId: string) {
    this.store.draft(draftId);
    const activeTurnId = this.store.activeTurnId(draftId);
    const items = [...this.store.conversations(draftId)]
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .map(record => this.toView(record, activeTurnId));
    return { items, currentId: this.store.currentConversation(draftId)?.id ?? null };
  }

  /** 新建/重置逻辑对话：旧 current 转为 idle 历史；needs_rebuild 诊断历史不受影响。 */
  async create(draftId: string, input: ConversationSelection & { expectedRevision: number; requestId: string }) {
    const selection = await this.providers.ready(input);
    const body = { op: "create", providerId: input.providerId, modelId: input.modelId, mode: input.mode ?? "multi", expectedRevision: input.expectedRevision, rebuildFromId: input.rebuildFromId ?? null };
    return this.store.command(`conversation:${draftId}`, input.requestId, body, () => this.store.transaction(() => {
      this.guardCommand(draftId, input.expectedRevision);
      if (input.rebuildFromId !== undefined && input.rebuildFromId !== null) {
        const source = this.requireConversation(draftId, input.rebuildFromId);
        check(source.status === "needs_rebuild", "CONVERSATION_CONFLICT", "仅可重建需要重建的对话", 409);
      }
      this.store.demoteCurrentConversation(draftId);
      const record = this.newRecord(draftId, selection.providerId, selection.modelId, input.mode ?? "multi", input.rebuildFromId ?? null, selection.setting.revision);
      this.store.insertConversation(record);
      return this.toView(this.store.conversation(record.id)!);
    }));
  }

  /** 重建上下文：等价于携带 rebuildFromId 的 create（同一事务与幂等语义），原会话保留为诊断历史。 */
  async rebuild(draftId: string, sourceId: string, input: ConversationSelection & { expectedRevision: number; requestId: string }) {
    return this.create(draftId, { ...input, rebuildFromId: sourceId });
  }

  /** idle → current 继续；原 current 自动转为 idle 历史。 */
  async resume(draftId: string, id: string, input: { expectedRevision: number; requestId: string }) {
    return this.command(draftId, input.requestId, { op: "resume", conversationId: id, expectedRevision: input.expectedRevision }, () => {
      this.guardCommand(draftId, input.expectedRevision);
      const record = this.requireConversation(draftId, id);
      check(record.status === "idle", "CONVERSATION_CONFLICT", "仅可继续历史对话（idle）", 409);
      return this.toView(this.store.resumeConversation(draftId, id));
    });
  }

  /** current/idle → archived 用户主动归档；消息、轮次、模型信息与审计数据保留。 */
  async archive(draftId: string, id: string, input: { expectedRevision: number; requestId: string }) {
    return this.command(draftId, input.requestId, { op: "archive", conversationId: id, expectedRevision: input.expectedRevision }, () => {
      this.guardCommand(draftId, input.expectedRevision);
      const record = this.requireConversation(draftId, id);
      check(record.status === "current" || record.status === "idle", "CONVERSATION_CONFLICT", "仅可归档当前或历史对话", 409);
      return this.toView(this.store.archiveConversation(draftId, id));
    });
  }

  /** archived → current 恢复；原 current 自动转为 idle 历史，archived_at 保留作审计。 */
  async restore(draftId: string, id: string, input: { expectedRevision: number; requestId: string }) {
    return this.command(draftId, input.requestId, { op: "restore", conversationId: id, expectedRevision: input.expectedRevision }, () => {
      this.guardCommand(draftId, input.expectedRevision);
      const record = this.requireConversation(draftId, id);
      check(record.status === "archived", "CONVERSATION_CONFLICT", "仅可恢复已归档对话", 409);
      return this.toView(this.store.restoreConversation(draftId, id));
    });
  }

  /** 手动修改标题；不影响消息内容和上下文。 */
  async rename(draftId: string, id: string, input: { title: string; expectedRevision: number; requestId: string }) {
    return this.command(draftId, input.requestId, { op: "rename", conversationId: id, title: input.title, expectedRevision: input.expectedRevision }, () => {
      this.guardCommand(draftId, input.expectedRevision);
      this.requireConversation(draftId, id);
      return this.toView(this.store.renameConversation(draftId, id, input.title));
    });
  }

  /** 轮次受理时解析实际会话；配置/模型变化在同一事务内原子轮换（旧对话转 idle）。 */
  ensureForTurn(draftId: string, selection: ConversationSelection & { mode?: ConversationMode }): ConversationRecord {
    const mode = selection.mode ?? "multi";
    const current = this.store.currentConversation(draftId);
    const setting = this.providers.setting(selection.providerId);
    const transport = transportOf(setting.config);
    const contextMode = mode === "single" ? "isolated" : "native";
    const matches = (candidate: ConversationRecord) => candidate.providerId === selection.providerId && candidate.modelId === selection.modelId
      && candidate.mode === mode && candidate.transport === transport && candidate.connectionFingerprint === connectionFingerprint(setting);
    if (selection.conversationId !== undefined && selection.conversationId !== null) {
      const explicit = this.requireConversation(draftId, selection.conversationId);
      if (explicit.status === "needs_rebuild") throw new AppError("SESSION_REBUILD_REQUIRED", "该会话后端上下文已中断，请重建上下文", 409);
      check(explicit.status === "current", "CONVERSATION_CONFLICT", "只能向当前会话提交；历史对话请先继续，已归档对话请先恢复", 409);
      check(matches(explicit) && explicit.id === current?.id, "CONVERSATION_CONFLICT", "Provider、模型或连接配置已变化，请新建会话", 409);
      return explicit;
    }
    if (current) {
      if (matches(current)) return current;
      this.store.demoteCurrentConversation(draftId);
      const record = this.newRecord(draftId, selection.providerId, selection.modelId, mode, null, setting.revision);
      this.store.insertConversation(record);
      return this.store.conversation(record.id)!;
    }
    // 无 current：最新的对话是 needs_rebuild → 强制显式重建；其余存量对话要求显式选择；空草稿首轮懒创建（旧客户端兼容）。
    const conversations = this.store.conversations(draftId);
    const latest = conversations.at(-1);
    if (latest?.status === "needs_rebuild") throw new AppError("SESSION_REBUILD_REQUIRED", "上一会话后端上下文已中断，请重建上下文或新建对话", 409);
    check(conversations.length === 0, "CONVERSATION_CONFLICT", "当前没有进行中的对话，请新建或继续一个对话", 409);
    const record = this.newRecord(draftId, selection.providerId, selection.modelId, mode, null, setting.revision);
    this.store.insertConversation(record);
    return this.store.conversation(record.id)!;
  }

  private command<T>(draftId: string, requestId: string, body: Record<string, unknown>, operation: () => T): T {
    return this.store.command(`conversation:${draftId}`, requestId, body, () => this.store.transaction(operation));
  }
  /** 写命令公共前置（事务内）：草稿存在、修订号一致、可编辑、无活动轮次。 */
  private guardCommand(draftId: string, expectedRevision: number) {
    const draft = this.store.draft(draftId);
    check(draft.revision === expectedRevision, "REVISION_CONFLICT", "草稿已更新，请刷新后重试", 409);
    check(draft.status === "draft", "DRAFT_BUSY", "草稿正在发布或不可编辑", 409);
    check(this.store.activeTurnId(draftId) === null, "DRAFT_BUSY", "草稿有活动轮次，请等待完成或取消后重试", 409);
  }
  /** 会话必须存在且属于该草稿；跨草稿引用统一 404，不泄露其他草稿。 */
  private requireConversation(draftId: string, id: string): ConversationRecord {
    const record = this.store.conversation(id);
    check(record !== undefined && record.draftId === draftId, "NOT_FOUND", "会话不属于该草稿", 404);
    return record;
  }

  private newRecord(draftId: string, providerId: string, modelId: string, mode: ConversationMode, rebuildFromId: string | null, providerRevision: number): Omit<ConversationRecord, "updatedAt"> {
    const setting = this.providers.setting(providerId);
    const transport = transportOf(setting.config);
    return {
      id: randomUUID(), draftId, mode,
      contextMode: mode === "single" ? "isolated" : "native",
      status: "current", providerId, providerRevision, modelId, transport,
      connectionFingerprint: connectionFingerprint(setting), cliVersion: null, backendRef: null,
      backendGeneration: 0, syncedRevision: null, rebuildFromId, title: null, archivedAt: null,
      createdAt: Date.now(), lastUsedAt: null,
    };
  }

  /** 派生字段（title 回退、最后用户消息摘要、最后轮次状态、活动轮次）在此补齐，不落库。 */
  private toView(record: ConversationRecord, activeTurnId?: string | null, connectionState: ConversationView["connectionState"] = "absent"): ConversationView {
    const firstUser = record.title === null ? this.store.userMessageText(record.id, "first") : null;
    const lastUser = this.store.userMessageText(record.id, "last");
    return {
      id: record.id, draftId: record.draftId, mode: record.mode, contextMode: record.contextMode,
      status: record.status, providerId: record.providerId, providerRevision: record.providerRevision,
      modelId: record.modelId, transport: record.transport, cliVersion: record.cliVersion,
      syncedRevision: record.syncedRevision, rebuildFromId: record.rebuildFromId,
      createdAt: record.createdAt, updatedAt: record.updatedAt, lastUsedAt: record.lastUsedAt, connectionState,
      title: record.title ?? (firstUser !== null ? titleFromPrompt(firstUser) : null),
      archivedAt: record.archivedAt,
      lastUserMessage: lastUser !== null ? summaryFromMessage(lastUser) : null,
      lastTurnStatus: this.store.lastTurnStatus(record.id),
      activeTurnId: activeTurnId === undefined ? this.store.activeTurnId(record.draftId) : activeTurnId,
    };
  }
}
