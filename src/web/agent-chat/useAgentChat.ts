import { useEffect, useRef, useState } from "react";
import type { AgentChoice, ProviderView } from "../../domain/types.js";
import { isModelEnabled } from "../../domain/models.js";
import { useCommandKey, useResource } from "../lib/api";
import type { AgentChatConfig, ChatAttachment } from "./types";

export function useAgentChat<Context>(config: AgentChatConfig<Context>, context: Context) {
  const providers = useResource<{ items: ProviderView[] }>("/providers");
  const preferenceKey = config.preferenceKey ?? "orchard-workbench-agent";
  const [preference, setChoice] = useState<AgentChoice>(() => {
    try { return JSON.parse(localStorage.getItem(preferenceKey) ?? "{}"); } catch { return {}; }
  });
  const choose = (value: AgentChoice) => {
    setChoice(value);
    try { localStorage.setItem(preferenceKey, JSON.stringify(value)); } catch {}
  };
  const availableProviders = (providers.data?.items ?? []).filter(item => !config.providerId || item.id === config.providerId);
  const defaultProvider = config.providerId ? availableProviders[0] : undefined;
  const preferredChoice = defaultProvider && preference.providerId !== defaultProvider.id
    ? { providerId: defaultProvider.id, modelId: defaultProvider.defaultModel }
    : preference;
  const session = config.useSession(context, preferredChoice, choose);
  const choice = session.backend ?? preferredChoice;
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false), [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [submission, setSubmission] = useState(0);
  const commandKey = useCommandKey(), submitting = useRef(false);
  const selection = useRef(0);
  const resetKey = config.attachments?.resetKey?.(context);
  const attachmentsEnabled = !!config.attachments && (config.attachments.enabled?.(context) ?? true);
  useEffect(() => {
    setAttachments([]); setHistoryOpen(false); setPickerOpen(false); setError("");
  }, [session.conversationId]);
  useEffect(() => { setPrompt(""); }, [session.draftKey ?? session.conversationId]);
  useEffect(() => { setAttachments([]); setPickerOpen(false); }, [resetKey, attachmentsEnabled]);
  const provider = availableProviders.find(item => item.id === choice.providerId);
  const modelAvailable = provider?.enabled && provider.readiness.state !== "unavailable" && provider.models.some(model => model.id === choice.modelId && isModelEnabled(model));
  const locked = busy || !!session.locked || !!session.active || !!session.loading;
  const canSend = !locked && !!modelAvailable && !!prompt.trim();
  const perform = async (action: () => Promise<void>) => {
    if (submitting.current) return;
    const selected = selection.current;
    submitting.current = true; setBusy(true); setError("");
    try { await action(); } catch (error) { if (selection.current === selected) setError((error as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  };
  const submit = () => {
    if (!canSend) return;
    const conversationId = session.conversationId, selected = selection.current;
    return perform(async () => {
      await session.send({ prompt: prompt.trim(), attachments, requestId: commandKey({ conversationId, choice, prompt, attachments, submission }) });
      if (selection.current === selected) setPrompt("");
      setSubmission(value => value + 1);
    });
  };
  return {
    session, providers: availableProviders, choice, prompt, setPrompt, attachments,
    historyOpen, setHistoryOpen, pickerOpen, setPickerOpen, busy, locked, canSend, attachmentsEnabled,
    error: error || session.error || providers.error,
    choose,
    addAttachment: (attachment: ChatAttachment) => setAttachments(current => [...current.filter(item => item.id !== attachment.id || item.kind !== attachment.kind), attachment]),
    removeAttachment: (attachment: ChatAttachment) => setAttachments(current => current.filter(item => item.id !== attachment.id || item.kind !== attachment.kind)),
    newConversation: () => {
      selection.current++;
      setPrompt(""); setAttachments([]); setPickerOpen(false); setHistoryOpen(false); setError("");
      session.newConversation();
    },
    selectConversation: (id: string) => {
      selection.current++;
      setPrompt(""); setAttachments([]); setPickerOpen(false); setHistoryOpen(false); setError("");
      session.selectConversation(id);
    },
    submit, perform,
  };
}
