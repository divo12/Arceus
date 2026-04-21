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
