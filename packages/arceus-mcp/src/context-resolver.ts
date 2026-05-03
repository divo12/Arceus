/**
 * Session-context resolver for the MCP server.
 *
 * Resolves beat metadata (beatId, companyId, role, allowedTools) by calling
 * the Arceus API's session-context endpoint. Caches per sessionId so repeated
 * tool calls in the same beat don't re-fetch.
 *
 * Phase 6.5 — Package G.
 */
import type { BeatContext } from "@arceus/contracts";

const cache = new Map<string, BeatContext>();

export async function resolveSessionContext(sessionId: string): Promise<BeatContext | null> {
  if (cache.has(sessionId)) return cache.get(sessionId)!;
  const api = process.env.ARCEUS_API;
  const token = process.env.ARCEUS_TOKEN;
  if (!api || !token) return null;
  try {
    const res = await fetch(
      `${api}/api/internal/telemetry/session-context/${sessionId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const ctx = await res.json() as BeatContext;
    cache.set(sessionId, ctx);
    return ctx;
  } catch {
    return null;
  }
}

