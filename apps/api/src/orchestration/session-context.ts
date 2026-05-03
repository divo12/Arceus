/**
 * Session-context map — bridges sessionID → BeatContext.
 *
 * The plugin and MCP server resolve beat metadata (allowedTools, beatId, role,
 * companyId) by calling GET /api/internal/telemetry/session-context/:sessionId.
 * This module owns the in-memory map that backs that route.
 *
 * Lifecycle:
 *   registerSessionContext()   — called in runBeat step 4 (after session.create)
 *   getSessionContext()        — called by the GET route (plugin/MCP resolver)
 *   unregisterSessionContext() — called in runBeat cleanup (step 19)
 *
 * Phase 6.5 — Package B.
 */
import type { BeatContext } from "@arceus/contracts";

const sessionContextMap = new Map<string, BeatContext>();

export function registerSessionContext(ctx: BeatContext): void {
  sessionContextMap.set(ctx.sessionId, ctx);
}

export function getSessionContext(sessionId: string): BeatContext | undefined {
  return sessionContextMap.get(sessionId);
}

export function unregisterSessionContext(sessionId: string): void {
  sessionContextMap.delete(sessionId);
}

export function sessionContextSize(): number {
  return sessionContextMap.size;
}

/** Clear all session contexts. Used during company reset. */
export function clearAllSessionContexts(): void {
  sessionContextMap.clear();
}

/**
 * Find the most recently registered session context for a given role.
 * Used as a fallback when MCP requests arrive without X-Beat-Id / X-Company-Id headers
 * (the MCP server is a shared long-running process that can't set per-beat headers).
 */
export function findActiveSessionContextByRole(role: string): BeatContext | undefined {
  for (const ctx of sessionContextMap.values()) {
    if (ctx.role === role) return ctx;
  }
  return undefined;
}

/**
 * Find any active session context. In v1 beats serialize, so at most one is
 * in-flight when an MCP tool call arrives. Returns undefined if the map is
 * empty or has more than one entry (ambiguous — caller must supply headers).
 */
export function findSoleActiveSessionContext(): BeatContext | undefined {
  if (sessionContextMap.size !== 1) return undefined;
  return sessionContextMap.values().next().value;
}
