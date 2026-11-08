import { useEffect, useState } from "react";
import type { ScriptAgentService } from "../../../authoring/script-agent.js";
import type { AgentChoice } from "../../../domain/types.js";
import { api, requestId, send, useResource } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { ErrorNotice } from "../../components/common";
import type { ScriptDetail } from "../../features/ScriptPages";
import { ScriptAgentPreview } from "../../features/ScriptAgentPreview";
import type { AgentChatConfig, AttachmentPickerProps, ChatMessage, ChatSession } from "../types";
import { useChatPolling } from "../useChatPolling";

type AgentHistory = ReturnType<ScriptAgentService["list"]>;
export interface ScriptChatContext {
  script: ScriptDetail;
  dirty: boolean;
  testRefresh?: number;
  onApplied: () => void;
  onTestInput: (input: unknown) => void;
}

function ScriptReferencePicker({ context, selected, onAdd, onClose }: AttachmentPickerProps<ScriptChatContext>) {
  const tests = useResource<{ items: { id: string; status: string; createdAt: number }[] }>(`/scripts/${context.script.id}/tests?limit=20`);
  useEffect(() => { tests.reload(); }, [context.testRefresh]);
  const selectedId = (selected.find(item => item.kind === "script-test")?.payload as { testId?: string } | undefined)?.testId ?? "";
  return <><label htmlFor="script-agent-test">引用测试结果</label><select id="script-agent-test" value={selectedId} onChange={event => {
    const test = tests.data?.items.find(item => item.id === event.target.value);
    if (!test) return;
    onAdd({ id: "script-test", kind: "script-test", label: `测试引用 · ${new Date(test.createdAt).toLocaleString("zh-CN")} · ${test.status}`, payload: { testId: test.id } }); onClose();
  }}><option value="">选择测试记录</option>{tests.data?.items.map(test => <option value={test.id} key={test.id}>{new Date(test.createdAt).toLocaleString("zh-CN")} · {test.status}</option>)}</select><ErrorNotice message={tests.error} />{!tests.data?.items.length && <p className="field-hint">暂无测试记录，请先运行一次脚本测试。</p>}<p className="field-hint">将所选测试的输入、输出和日志提供给 Agent。</p></>;
}

function useScriptSession(context: ScriptChatContext, choice: AgentChoice): ChatSession {
  const { script, dirty, onApplied, onTestInput } = context;
  const [conversationId, setConversationId] = useState<string>(requestId);
  const [preview, setPreview] = useState("");
  const [refresh, setRefresh] = useState(0);
  const conversations = useResource<ReturnType<ScriptAgentService["conversations"]>>(`/scripts/${script.id}/agent/conversations`);
  const history = useChatPolling(`${script.id}:${conversationId}:${refresh}`, async signal => {
    const result = await api<AgentHistory>(`/scripts/${script.id}/agent/turns?offset=0&limit=100&conversationId=${encodeURIComponent(conversationId)}`, { signal });
    while (result.items.length < result.total) {
      const page = await api<AgentHistory>(`/scripts/${script.id}/agent/turns?offset=${result.items.length}&limit=100&conversationId=${encodeURIComponent(conversationId)}`, { signal });
      if (!page.items.length) break;
      result.items.push(...page.items);
    }
    return result;
  }, data => !!data.activeCount, 750);
  useEffect(() => { conversations.reload(); }, [refresh, history.data?.activeCount]);
  const selectedConversation = conversations.data?.items.find(item => item.id === conversationId);
  const locked = dirty || !script.draft || script.status === "archived" || !!selectedConversation?.archived || (!!selectedConversation && selectedConversation.draftVersionId !== script.currentDraftVersionId);
  const selectConversation = (id: string) => { setConversationId(id); setPreview(""); };
  const turns = history.data?.items.filter(turn => turn.conversationId === conversationId).slice().reverse() ?? [];
  const activeTurn = history.data?.items.find(turn => ["queued", "running"].includes(turn.status));
  const messages: ChatMessage[] = turns.flatMap(turn => {
    return [
      { id: `${turn.id}:user`, role: "user", text: turn.prompt },
      {
        id: `${turn.id}:assistant`, role: turn.error ? "error" : "assistant",
        text: turn.summary ?? turn.error?.message ?? (turn.status === "cancelled" ? "已停止生成" : turn.status === "interrupted" ? "对话已中断，请重新发送" : turn.status === "failed" ? "回复失败，请重试" : turn.status === "succeeded" ? "回复已完成" : "正在分析脚本与上下文…"),
        pending: ["queued", "running"].includes(turn.status),
        content: (turn.hasChanges || turn.hasTestInput) ? <div className="agent-chat-change">
          <Button variant="outline" size="sm" onClick={() => setPreview(preview === turn.id ? "" : turn.id)}>{preview === turn.id ? "收起详情" : !turn.hasChanges ? "查看测试输入" : turn.appliedRevision !== null ? "查看已应用变更" : "查看变更"}</Button>
          {preview === turn.id && <ScriptAgentPreview script={script} turnId={turn.id} disabled={locked || !!history.data?.activeCount} onApplied={() => { onApplied(); setRefresh(value => value + 1); }} onTestInput={onTestInput} />}
        </div> : undefined,
      },
    ];
  });
  return {
    conversationId, title: selectedConversation?.title.trim() || turns[0]?.prompt.trim() || "新对话",
    conversations: (conversations.data?.items ?? []).map(item => ({
      id: item.id, title: item.title,
      meta: `${new Date(item.updatedAt).toLocaleString("zh-CN")}${item.archived ? " · 已归档" : ""}${item.draftVersionId !== script.currentDraftVersionId ? " · 历史草稿，只读" : ""}`,
      actions: [
        ...(!item.archived && item.draftVersionId === script.currentDraftVersionId ? [{ id: "continue", label: "继续对话", run: async () => selectConversation(item.id) }] : []),
        ...(!item.archived ? [{ id: "archive", label: "归档", disabled: item.active, run: async () => {
          await send(`/scripts/${script.id}/agent/conversations/${encodeURIComponent(item.id)}/archive`);
          if (item.id === conversationId) selectConversation(requestId());
          conversations.reload();
        } }] : []),
      ],
    })),
    messages, loading: !history.data && !history.error,
    error: history.error || conversations.error, active: !!history.data?.activeCount,
    locked, managementLocked: !!history.data?.activeCount,
    hint: dirty ? "先保存或放弃本地修改，再继续对话" : "变更需确认后保存",
    newConversation: () => selectConversation(requestId()), selectConversation,
    send: async submission => {
      const attachment = submission.attachments.find(item => item.kind === "script-test");
      const testId = (attachment?.payload as { testId?: string } | undefined)?.testId;
      await send(`/scripts/${script.id}/agent/turns`, { ...choice, prompt: submission.prompt, conversationId, expectedRevision: script.draft!.revision, requestId: submission.requestId, ...(testId ? { testId } : {}) });
      setRefresh(value => value + 1);
    },
    cancel: activeTurn ? async () => { await send(`/scripts/${script.id}/agent/turns/${activeTurn.id}/cancel`); history.reload(); } : undefined,
  };
}

export const scriptChatConfig: AgentChatConfig<ScriptChatContext> = {
  id: "script", label: "脚本 Agent 对话", promptLabel: "描述脚本需求或修复要求",
  placeholder: "描述需求，或继续修改脚本…",
  welcome: { title: "描述你想编写的脚本", description: "描述需求，或添加测试引用，让 Agent 协助分析和修复。", hint: "生成过程不会执行或发布脚本。" },
  useSession: useScriptSession,
  attachments: { renderPicker: props => <ScriptReferencePicker {...props} /> },
};
