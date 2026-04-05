import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { chatApi } from "../api/chat";
import { useCompany } from "../context/CompanyContext";
import { buildApiUrl } from "../lib/api-origin";
import { queryKeys } from "../lib/queryKeys";
import type { ChatMessage } from "@paperclipai/shared";

export interface StreamingState {
  isStreaming: boolean;
  tokens: string;
  cards: Array<{ cardType: string; cardData: unknown }>;
}

export function useChat() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState<StreamingState>({
    isStreaming: false,
    tokens: "",
    cards: [],
  });
  const abortRef = useRef<AbortController | null>(null);

  const companyId = selectedCompanyId ?? "";

  const messagesQuery = useQuery({
    queryKey: queryKeys.chat.messages(companyId),
    queryFn: () => chatApi.messages(companyId),
    enabled: !!companyId,
  });

  const cardActionMutation = useMutation({
    mutationFn: ({
      messageId,
      action,
      editedData,
    }: {
      messageId: string;
      action: string;
      editedData?: unknown;
    }) => chatApi.cardAction(companyId, messageId, { action, editedData }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(companyId) });
    },
  });

  const sendMessage = useCallback(
    async (content: string) => {
      if (!companyId || streaming.isStreaming) return;

      // Optimistically add user message
      const optimisticUserMsg: ChatMessage = {
        id: `temp-${Date.now()}`,
        companyId,
        role: "user",
        content,
        cardType: null,
        cardData: null,
        cardState: null,
        agentId: null,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<ChatMessage[]>(queryKeys.chat.messages(companyId), (old) => [
        ...(old ?? []),
        optimisticUserMsg,
      ]);

      setStreaming({ isStreaming: true, tokens: "", cards: [] });

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const res = await fetch(buildApiUrl(`/companies/${companyId}/chat`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ content }),
          signal: abort.signal,
        });

        if (!res.ok || !res.body) {
          setStreaming((s) => ({ ...s, isStreaming: false }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        let streamEnded = false;
        while (!streamEnded) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEvent = "";
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                handleSSEEvent(currentEvent, data);
                if (currentEvent === "done") {
                  streamEnded = true;
                }
              } catch {
                // ignore parse errors
              }
              currentEvent = "";
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("Chat stream error:", err);
        }
      } finally {
        setStreaming({ isStreaming: false, tokens: "", cards: [] });
        abortRef.current = null;
        // Refetch to get server-stored messages (with proper IDs)
        queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(companyId) });
      }

      function handleSSEEvent(event: string, data: unknown) {
        const d = data as Record<string, unknown>;
        if (d.token !== undefined) {
          setStreaming((s) => ({
            ...s,
            tokens: s.tokens + String(d.token),
          }));
        } else if (d.cardType) {
          setStreaming((s) => ({
            ...s,
            cards: [...s.cards, { cardType: d.cardType as string, cardData: d.cardData }],
          }));
        } else if (d.error) {
          console.error("Chat stream error from server:", d.error);
        }
      }
    },
    [companyId, streaming.isStreaming, queryClient],
  );

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    setStreaming({ isStreaming: false, tokens: "", cards: [] });
  }, []);

  return {
    messages: messagesQuery.data ?? [],
    isLoading: messagesQuery.isLoading,
    streaming,
    sendMessage,
    cancelStream,
    cardAction: cardActionMutation.mutate,
    isCardActionPending: cardActionMutation.isPending,
  };
}
