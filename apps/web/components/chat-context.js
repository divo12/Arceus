"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const CHAT_STORAGE_KEY = "arceus-board-messages";
const RESOLVED_PROPOSALS_KEY = "arceus-resolved-proposals";
const ChatContext = createContext(undefined);
function readStorage(key, fallback) {
    if (typeof window === "undefined")
        return fallback;
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    }
    catch {
        return fallback;
    }
}
export function ChatProvider({ children }) {
    const [messages, setMessagesRaw] = useState([]);
    const [resolvedProposalIds, setResolvedProposalIdsRaw] = useState([]);
    const hydrated = useRef(false);
    // Hydrate from localStorage before paint (no flash, no SSR mismatch).
    useIsomorphicLayoutEffect(() => {
        const savedMessages = readStorage(CHAT_STORAGE_KEY, []);
        const savedProposals = readStorage(RESOLVED_PROPOSALS_KEY, []);
        if (savedMessages.length > 0)
            setMessagesRaw(savedMessages);
        if (savedProposals.length > 0)
            setResolvedProposalIdsRaw(savedProposals);
        hydrated.current = true;
    }, []);
    // Persist messages — only after hydration to avoid writing [] on mount.
    useEffect(() => {
        if (!hydrated.current)
            return;
        try {
            window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
        }
        catch { /* ignore */ }
    }, [messages]);
    useEffect(() => {
        if (!hydrated.current)
            return;
        try {
            window.localStorage.setItem(RESOLVED_PROPOSALS_KEY, JSON.stringify(resolvedProposalIds));
        }
        catch { /* ignore */ }
    }, [resolvedProposalIds]);
    const clearMessages = useCallback(() => {
        setMessagesRaw([]);
        setResolvedProposalIdsRaw([]);
        try {
            window.localStorage.removeItem(CHAT_STORAGE_KEY);
            window.localStorage.removeItem(RESOLVED_PROPOSALS_KEY);
        }
        catch { /* ignore */ }
    }, []);
    return (_jsx(ChatContext.Provider, { value: {
            messages,
            setMessages: setMessagesRaw,
            resolvedProposalIds,
            setResolvedProposalIds: setResolvedProposalIdsRaw,
            clearMessages,
        }, children: children }));
}
export function useChatMessages() {
    const context = useContext(ChatContext);
    if (!context) {
        throw new Error("useChatMessages must be used within a ChatProvider");
    }
    return context;
}
