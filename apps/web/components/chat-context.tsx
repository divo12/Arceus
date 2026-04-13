"use client";

import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useRef, type ReactNode, type Dispatch, type SetStateAction } from "react";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const CHAT_STORAGE_KEY = "arceus-board-messages";
const RESOLVED_PROPOSALS_KEY = "arceus-resolved-proposals";

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
  const [messages, setMessagesRaw] = useState<Message[]>([]);
  const [resolvedProposalIds, setResolvedProposalIdsRaw] = useState<string[]>([]);
  const hydrated = useRef(false);

  // Hydrate from localStorage before paint (no flash, no SSR mismatch).
  useIsomorphicLayoutEffect(() => {
    const savedMessages = readStorage<Message[]>(CHAT_STORAGE_KEY, []);
    const savedProposals = readStorage<string[]>(RESOLVED_PROPOSALS_KEY, []);
    if (savedMessages.length > 0) setMessagesRaw(savedMessages);
    if (savedProposals.length > 0) setResolvedProposalIdsRaw(savedProposals);
    hydrated.current = true;
  }, []);

  // Persist messages — only after hydration to avoid writing [] on mount.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
    } catch { /* ignore */ }
  }, [messages]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(RESOLVED_PROPOSALS_KEY, JSON.stringify(resolvedProposalIds));
    } catch { /* ignore */ }
  }, [resolvedProposalIds]);

  const clearMessages = useCallback(() => {
    setMessagesRaw([]);
    setResolvedProposalIdsRaw([]);
    try {
      window.localStorage.removeItem(CHAT_STORAGE_KEY);
      window.localStorage.removeItem(RESOLVED_PROPOSALS_KEY);
    } catch { /* ignore */ }
  }, []);

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
