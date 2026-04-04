import type { ChatMessage } from "@paperclipai/shared";
import { api } from "./client";

export const chatApi = {
  messages: (companyId: string, limit = 50, before?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    return api.get<ChatMessage[]>(`/companies/${companyId}/chat/messages?${params}`);
  },

  /** POST that returns an SSE stream. Caller must handle the EventSource-like response. */
  sendMessageStream: (companyId: string, content: string): EventSource => {
    // We POST via fetch and get SSE back in the same connection,
    // but EventSource only supports GET. So we use fetch + ReadableStream.
    // This helper is NOT used directly; see the hook's streamSend for the actual fetch.
    throw new Error("Use streamSend in useChat hook instead");
  },

  /** Approve / reject / edit a card on a message */
  cardAction: (companyId: string, messageId: string, body: { action: string; editedData?: unknown }) =>
    api.patch<ChatMessage>(`/companies/${companyId}/chat/messages/${messageId}/card-action`, body),
};
