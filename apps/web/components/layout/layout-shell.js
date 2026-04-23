"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Sidebar } from "./sidebar";
/**
 * Top-level layout: sidebar + main content area.
 * The main content area is where pages render.
 * Chat + context split is handled per-page (the home page uses ResizableSplit).
 */
export function LayoutShell({ children }) {
    return (_jsxs("div", { className: "flex h-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]", children: [_jsx(Sidebar, {}), _jsx("main", { className: "flex min-w-0 flex-1 flex-col overflow-y-auto", children: children })] }));
}
