"use client";

import { Sidebar } from "./sidebar";

interface LayoutShellProps {
  children: React.ReactNode;
}

/**
 * Top-level layout: sidebar + main content area.
 * The main content area is where pages render.
 * Chat + context split is handled per-page (the home page uses ResizableSplit).
 */
export function LayoutShell({ children }: LayoutShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
