import { useState } from "react";
import type { AgentChoice } from "../../../domain/types.js";
import type { BridgeAgentService } from "../../../web-bridge/agent.js";
import { api, requestId, send } from "../../lib/api";
import { Button } from "../../components/ui/button";
import type { AgentChatConfig, ChatSession } from "../types";
import { useChatPolling } from "../useChatPolling";

export type BridgeAgentHistory = ReturnType<BridgeAgentService["list"]>;
export type BridgeTurnView = BridgeAgentHistory["items"][number];
export interface BrowserApplicationChatContext {
  application: { id: string; name: string };
  toolId?: string;
  testContext?: string;
  refresh: number;
  onReview: (turn: BridgeTurnView) => void;
}

export function bridgePreference(key: string, fallback = "") {
  try { return localStorage.getItem(`orchard.bridge.${key}`) ?? fallback; } catch { return fallback; }
}

export function saveBridgePreference(key: string, value: string) {
  try { localStorage.setItem(`orchard.bridge.${key}`, value); } catch {}
}

function useBrowserApplicationSession(context: BrowserApplicationChatContext, choice: AgentChoice): ChatSession {
  const { application, toolId, refresh, onReview } = context;
  const [conversationId, setConversationId] = useState(() => bridgePreference(`${application.id}.conversation`) || requestId());
  const [revision, setRevision] = useState(0);
  const base = `/web-bridge/applications/${application.id}/agent/turns`;
  const history = useChatPolling(`${base}:${conversationId}:${revision}:${refresh}`, async signal => {
    const result = await api<BridgeAgentHistory>(`${base}?conversationId=${encodeURIComponent(conversationId)}`, { signal });
    if (!Array.isArray(result.items) || !Array.isArray(result.conversations)) throw new Error("Agent 对话加载失败，请稍后重试");
    return result;
  }, data => !!data.active);
  const selectConversation = (id: string) => { setConversationId(id); saveBridgePreference(`${application.id}.conversation`, id); };
  const turns = history.data?.items.filter(turn => turn.conversationId === conversationId) ?? [];
  return {
    conversationId, title: history.data?.conversations.find(item => item.id === conversationId)?.title || turns[0]?.prompt || "新对话",
    conversations: (history.data?.conversations ?? []).map(item => ({ id: item.id, title: item.title, meta: new Date(item.updatedAt).toLocaleString("zh-CN") })),
    messages: turns.flatMap(turn => [
      { id: `${turn.id}:user`, role: "user" as const, text: turn.prompt },
      {
        id: `${turn.id}:assistant`, role: turn.error ? "error" as const : "assistant" as const,
        text: turn.proposal?.summary ?? turn.error?.message ?? (turn.status === "cancelled" ? "已停止生成" : turn.status === "interrupted" ? "生成已中断，请重新提交" : turn.status === "failed" ? "回复失败，请重试" : "正在分析应用配置…"),
        pending: ["queued", "running"].includes(turn.status),
        content: !!turn.proposal?.changes.length && <div className="agent-chat-change"><Button size="sm" variant="outline" onClick={() => onReview(turn)}>{turn.appliedHash ? "查看已应用变更" : `审阅 ${turn.proposal.changes.length} 项变更`}</Button></div>,
      },
    ]),
    notice: <p className="field-hint">当前应用：{application.name}{toolId ? ` · 当前工具：${toolId}` : ""}</p>,
    loading: !history.data && !history.error, error: history.error,
    active: !!history.data?.active, managementLocked: !!history.data?.active,
    newConversation: () => selectConversation(requestId()), selectConversation,
    send: async submission => {
      const attachment = submission.attachments.find(item => item.kind === "browser-test");
      const attachedTest = (attachment?.payload as { testContext?: string } | undefined)?.testContext;
      await send(base, { ...choice, conversationId, prompt: submission.prompt, toolId, ...(attachedTest ? { testContext: attachedTest } : {}), requestId: submission.requestId });
      setRevision(value => value + 1);
    },
    cancel: history.data?.active ? async () => { await send(`${base}/${history.data!.active}/cancel`); history.reload(); } : undefined,
  };
}

export const browserApplicationChatConfig: AgentChatConfig<BrowserApplicationChatContext> = {
  id: "browser-application", label: "应用 Agent 对话", promptLabel: "Agent 维护需求",
  preferenceKey: "orchard.bridge.provider",
  placeholder: "描述需求，或继续修改应用工具…",
  welcome: { title: "一起维护这个应用", description: "描述工具需求，或选择工具后提出修改。变更会先供你审阅。" },
  useSession: useBrowserApplicationSession,
  attachments: {
    enabled: context => !!context.testContext,
    resetKey: context => `${context.toolId ?? ""}:${context.testContext ?? ""}`,
    renderPicker: ({ context, onAdd, onClose }) => <Button variant="ghost" disabled={!context.testContext} onClick={() => {
      onAdd({ id: "current-test", kind: "browser-test", label: "当前工具测试结果", payload: { testContext: context.testContext } }); onClose();
    }}>添加当前测试结果</Button>,
  },
};
