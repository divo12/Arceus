"use client";

/**
 * NavShell — transparent wrapper.
 * The living dashboard (page.tsx) handles its own chrome.
 * Kept as a pass-through so other routes still render.
 */
export function NavShell({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
