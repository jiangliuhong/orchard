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

/** 逻辑对话生命周期；不启动后端进程、不包含 backend ref 到公开返回值。 */
export class ConversationService {
  constructor(readonly store: Store, readonly providers: ProviderRegistry) {}

  view(id: string, connectionState: ConversationView["connectionState"] = "absent") {
    return this.store.conversationView(id, connectionState);
  }

  list(draftId: string) {
    this.store.draft(draftId);
    const items = this.store.conversations(draftId).map(record => this.toView(record));
    return { items, currentId: this.store.currentConversation(draftId)?.id ?? null };
  }

  /** 新建/重置逻辑对话；同一草稿最多一个 current/needs_rebuild。 */
  async create(draftId: string, input: ConversationSelection & { expectedRevision: number; requestId: string }) {
    const selection = await this.providers.ready(input);
    const body = { providerId: input.providerId, modelId: input.modelId, mode: input.mode ?? "multi", expectedRevision: input.expectedRevision, rebuildFromId: input.rebuildFromId ?? null };
    return this.store.command(`conversation:${draftId}`, input.requestId, body, () => this.store.transaction(() => {
      const draft = this.store.draft(draftId);
      check(draft.revision === input.expectedRevision, "REVISION_CONFLICT", "草稿已更新，请刷新后重试", 409);
      check(draft.status === "draft", "DRAFT_BUSY", "草稿正在发布或不可编辑", 409);
      check(!this.store.turns(draftId).some(turn => ["queued", "running", "cancel_requested"].includes(turn.status)), "DRAFT_BUSY", "草稿有活动轮次", 409);
      if (input.rebuildFromId !== undefined && input.rebuildFromId !== null) {
        const source = this.store.conversation(input.rebuildFromId);
        check(source?.draftId === draftId && source.status === "current", "CONVERSATION_CONFLICT", "重建来源不是当前草稿会话", 409);
      }
      this.store.archiveCurrentConversations(draftId);
      const record = this.newRecord(draftId, selection.providerId, selection.modelId, input.mode ?? "multi", input.rebuildFromId ?? null, selection.setting.revision);
      this.store.insertConversation(record);
      return this.toView(this.store.conversation(record.id)!);
    }));
  }

  /** 轮次受理时解析实际会话；配置/模型变化会原子轮换。 */
  ensureForTurn(draftId: string, selection: ConversationSelection & { mode?: ConversationMode }): ConversationRecord {
    const mode = selection.mode ?? "multi";
    const current = this.store.currentConversation(draftId);
    const setting = this.providers.setting(selection.providerId);
    const transport = transportOf(setting.config);
    const contextMode = mode === "single" ? "isolated" : transport === "native" ? "native" : "reconstructed";
    const fingerprint = connectionFingerprint(setting);
    const matches = current && current.status === "current" && current.providerId === selection.providerId && current.modelId === selection.modelId && current.mode === mode && current.transport === transport && current.connectionFingerprint === fingerprint;
    if (current?.status === "needs_rebuild" && (selection.conversationId === undefined || selection.conversationId === current.id)) {
      throw new AppError("SESSION_REBUILD_REQUIRED", "当前会话需要重建上下文", 409);
    }
    if (selection.conversationId !== undefined && selection.conversationId !== null) {
      const explicit = this.store.conversation(selection.conversationId);
      check(explicit?.draftId === draftId, "NOT_FOUND", "会话不属于该草稿", 404);
      check(explicit.status === "current", "CONVERSATION_CONFLICT", "只能向当前会话提交", 409);
      check(matches && explicit.id === current?.id, "CONVERSATION_CONFLICT", "Provider、模型或连接配置已变化，请新建会话", 409);
      return explicit;
    }
    if (matches) return current!;
    this.store.archiveCurrentConversations(draftId);
    const record = this.newRecord(draftId, selection.providerId, selection.modelId, mode, null, setting.revision);
    this.store.insertConversation(record);
    return this.store.conversation(record.id)!;
  }

  private newRecord(draftId: string, providerId: string, modelId: string, mode: ConversationMode, rebuildFromId: string | null, providerRevision: number): Omit<ConversationRecord, "updatedAt"> {
    const setting = this.providers.setting(providerId);
    const transport = transportOf(setting.config);
    return {
      id: randomUUID(), draftId, mode,
      contextMode: mode === "single" ? "isolated" : transport === "native" ? "native" : "reconstructed",
      status: "current", providerId, providerRevision, modelId, transport,
      connectionFingerprint: connectionFingerprint(setting), cliVersion: null, backendRef: null,
      backendGeneration: 0, syncedRevision: null, rebuildFromId, createdAt: Date.now(), lastUsedAt: null,
    };
  }

  private toView(record: ConversationRecord): ConversationView {
    return {
      id: record.id, draftId: record.draftId, mode: record.mode, contextMode: record.contextMode,
      status: record.status, providerId: record.providerId, providerRevision: record.providerRevision,
      modelId: record.modelId, transport: record.transport, cliVersion: record.cliVersion,
      syncedRevision: record.syncedRevision, rebuildFromId: record.rebuildFromId,
      createdAt: record.createdAt, updatedAt: record.updatedAt, lastUsedAt: record.lastUsedAt,
      connectionState: "absent",
    };
  }
}
