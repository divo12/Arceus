/**
 * Spec 35 — In-process chat event bus.
 *
 * Tiny pub/sub for the chat surface. Producers (chat routes, MCP
 * `chat_emit_card` handler) publish; subscribers (the chat SSE
 * stream) fan out to clients filtered by companyId.
 *
 * Intentionally separate from the inspector event bus — chat events
 * are user-facing UI signals, not observability records.
 */
import type { ChatMessage } from "@arceus/contracts";

export type ChatEvent =
  | { type: "chat.message_added"; companyId: string; message: ChatMessage }
  | { type: "chat.card_added"; companyId: string; message: ChatMessage }
  | { type: "chat.card_decided"; companyId: string; message: ChatMessage }
  | { type: "chat.token"; companyId: string; messageId: string; content: string }
  | { type: "chat.turn_started"; companyId: string }
  | { type: "chat.turn_ended"; companyId: string };

type ChatListener = (event: ChatEvent) => void;

const listeners = new Set<ChatListener>();

export function publishChatEvent(event: ChatEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Never let a broken subscriber take down the producer.
    }
  }
}

export function subscribeChat(listener: ChatListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
