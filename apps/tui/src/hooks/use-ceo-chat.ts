import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api/client.js";
import { connectNamedSSE, type SSEHandle } from "../api/streams.js";
import type { ChatMessage, CompanySnapshot } from "@arceus/contracts";

export interface CeoChatState {
  messages: ChatMessage[];
  streaming: boolean;
  streamText: string;
  error: string | null;
  send: (message: string) => void;
  refreshHistory: () => void;
  clearMessages: () => void;
}

const CEO_SSE_EVENTS = ["board", "status", "token", "proposal", "meeting", "error", "done"];

export function useCeoChat(): CeoChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<SSEHandle | null>(null);

  const refreshHistory = useCallback(() => {
    // eslint-disable-next-line no-restricted-syntax -- intentional: TUI CEO chat fire-and-forget — UI shows error from server response.
    api<CompanySnapshot>("/api/company")
      .then((snap) => setMessages(snap.chatMessages ?? []))
      .catch(() => {});
  }, []);

  // Load history on mount
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const send = useCallback(
    (message: string) => {
      if (streaming || !message.trim()) return;

      setStreaming(true);
      setStreamText("");
      setError(null);

      handleRef.current?.close();

      const encodedMsg = encodeURIComponent(message.trim());
      handleRef.current = connectNamedSSE(
        `/api/chat/ceo/stream?message=${encodedMsg}`,
        CEO_SSE_EVENTS,
        (event, data) => {
          if (event === "token" && typeof data.content === "string") {
            setStreamText(data.content);
          }
          if (event === "error" && typeof data.message === "string") {
            setError(data.message);
          }
          if (event === "done") {
            setStreaming(false);
            refreshHistory();
          }
        },
        () => {
          setStreaming(false);
          refreshHistory();
        },
      );
    },
    [streaming, refreshHistory],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      handleRef.current?.close();
    };
  }, []);

  const clearMessages = () => setMessages([]);

  return { messages, streaming, streamText, error, send, refreshHistory, clearMessages };
}
