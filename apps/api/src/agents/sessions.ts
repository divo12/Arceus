import type { AgentSessionState } from "../orchestration/state.js";
import { agentSessions } from "../orchestration/state.js";

/**
 * Update an agent session with a partial state patch.
 * `key` is the compound `companyId:role` string from agentSessionKey().
 */
export function updateAgentSessionState(key: string, patch: Partial<AgentSessionState>) {
  const session = agentSessions.get(key);
  if (!session) return;
  Object.assign(session, patch);
}

/**
 * Touch an agent session's timestamp and optionally update its status.
 * `key` is the compound `companyId:role` string from agentSessionKey().
 */
export function touchAgentSession(key: string, status?: AgentSessionState["status"]) {
  const session = agentSessions.get(key);
  if (!session) return;
  session.lastEventAt = new Date().toISOString();
  if (status) {
    session.status = status;
  }
}

/** Build a human-readable summary of why a developer session may be stalled. */
export function summarizeDeveloperStall(session: AgentSessionState) {
  const details = [
    session.awaiting ? `Awaiting: ${session.awaiting}.` : null,
    session.lastToolName ? `Last tool: ${session.lastToolName}${session.lastToolStatus ? ` (${session.lastToolStatus})` : ""}` : null,
    session.lastEventSummary ? `Last session update: ${session.lastEventSummary}` : null,
    session.lastWorkspaceChangeAt ? `Last workspace change: ${session.lastWorkspaceChangeAt}.` : null,
    session.lastProgressAt ? `Last recorded progress: ${session.lastProgressAt}.` : null,
  ].filter(Boolean);
  return details.join(" ");
}

/**
 * Reverse-lookup the compound `companyId:role` key that owns a given OpenCode session ID.
 * Returns null if not found (e.g. a beat session not in agentSessions).
 */
export function resolveRoleBySessionId(sessionId: string): string | null {
  for (const [key, session] of agentSessions) {
    if (session.sessionId === sessionId) return key;
  }
  return null;
}

/**
 * Extract the role from a compound `companyId:role` key.
 * Internal agent keys (`_internal/...`) are returned as-is.
 */
export function roleFromKey(key: string): string {
  const colonIdx = key.indexOf(":");
  return colonIdx === -1 ? key : key.slice(colonIdx + 1);
}
