"use client";

import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useRef, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { useAuth } from "../../contexts/auth-context";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function chatStorageKey(userId: string | null | undefined) {
  return userId ? `arceus-board-messages-${userId}` : "arceus-board-messages";
}
function proposalsStorageKey(userId: string | null | undefined) {
  return userId ? `arceus-resolved-proposals-${userId}` : "arceus-resolved-proposals";
}

// Generic message shape — page.tsx defines the full ChatBubble type
// and uses this context with that concrete type via the hook.
type Message = Record<string, unknown>;

interface ChatContextValue {
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  resolvedProposalIds: string[];
  setResolvedProposalIds: Dispatch<SetStateAction<string[]>>;
  clearMessages: () => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.userId ?? null;
  const [messages, setMessagesRaw] = useState<Message[]>([]);
  const [resolvedProposalIds, setResolvedProposalIdsRaw] = useState<string[]>([]);
  const hydrated = useRef(false);

  // Re-hydrate when userId changes (login/logout) — clear and reload from the correct key.
  useIsomorphicLayoutEffect(() => {
    hydrated.current = false;
    setMessagesRaw([]);
    setResolvedProposalIdsRaw([]);
    const savedMessages = readStorage<Message[]>(chatStorageKey(userId), []);
    const savedProposals = readStorage<string[]>(proposalsStorageKey(userId), []);
    if (savedMessages.length > 0) setMessagesRaw(savedMessages);
    if (savedProposals.length > 0) setResolvedProposalIdsRaw(savedProposals);
    hydrated.current = true;
  }, [userId]);

  // Persist messages — only after hydration to avoid writing [] on mount.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(chatStorageKey(userId), JSON.stringify(messages));
    } catch { /* ignore */ }
  }, [messages, userId]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(proposalsStorageKey(userId), JSON.stringify(resolvedProposalIds));
    } catch { /* ignore */ }
  }, [resolvedProposalIds, userId]);

  const clearMessages = useCallback(() => {
    setMessagesRaw([]);
    setResolvedProposalIdsRaw([]);
    try {
      window.localStorage.removeItem(chatStorageKey(userId));
      window.localStorage.removeItem(proposalsStorageKey(userId));
    } catch { /* ignore */ }
  }, [userId]);

  return (
    <ChatContext.Provider value={{
      messages,
      setMessages: setMessagesRaw,
      resolvedProposalIds,
      setResolvedProposalIds: setResolvedProposalIdsRaw,
      clearMessages,
    }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChatMessages() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChatMessages must be used within a ChatProvider");
  }
  return context;
}
