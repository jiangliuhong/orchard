import type { ReactNode } from "react";
import type { AgentChoice } from "../../domain/types.js";

export interface ChatAttachment {
  id: string;
  kind: string;
  label: string;
  payload: unknown;
}

export interface AttachmentPickerProps<Context> {
  context: Context;
  selected: ChatAttachment[];
  onAdd: (attachment: ChatAttachment) => void;
  onClose: () => void;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  pending?: boolean;
  content?: ReactNode;
}

export interface ChatConversation {
  id: string;
  title: string;
  meta?: string;
  notice?: string;
  excerpt?: string;
  group?: string;
  archived?: boolean;
  actions?: {
    id: string;
    label: string;
    accessibleLabel?: string;
    disabled?: boolean;
    run: (title?: string) => Promise<void>;
  }[];
}

export interface ChatSubmission {
  prompt: string;
  attachments: ChatAttachment[];
  requestId: string;
}

export interface ChatSession {
  conversationId: string;
  draftKey?: string;
  title: string;
  conversations: ChatConversation[];
  messages: ChatMessage[];
  loading?: boolean;
  error?: string;
  active?: boolean;
  stopping?: boolean;
  locked?: boolean;
  managementLocked?: boolean;
  hint?: string;
  historyHint?: string;
  notice?: ReactNode;
  noticeActions?: { label: string; run: () => Promise<void> }[];
  newConversation: () => void;
  selectConversation: (id: string) => void;
  send: (submission: ChatSubmission) => Promise<void>;
  cancel?: () => Promise<void>;
}

export interface AgentChatConfig<Context> {
  id: string;
  label: string;
  promptLabel: string;
  placeholder: string;
  welcome: { title: string; description: string; hint?: string };
  preferenceKey?: string;
  useSession: (context: Context, choice: AgentChoice, choose: (choice: AgentChoice) => void) => ChatSession;
  attachments?: {
    enabled?: (context: Context) => boolean;
    resetKey?: (context: Context) => string;
    renderPicker: (props: AttachmentPickerProps<Context>) => ReactNode;
  };
}
