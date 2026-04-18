import type { AgentSessionState } from "../orchestration/state.js";
import { agentSessions } from "../orchestration/state.js";

export function updateAgentSessionState(role: string, patch: Partial<AgentSessionState>) {
  const session = agentSessions.get(role);
  if (!session) return;
  Object.assign(session, patch);
}

export function touchAgentSession(role: string, status?: AgentSessionState["status"]) {
  const session = agentSessions.get(role);
  if (!session) return;
  session.lastEventAt = new Date().toISOString();
  if (status) {
    session.status = status;
  }
}

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

export function resolveRoleBySessionId(sessionId: string): string | null {
  for (const [role, session] of agentSessions) {
    if (session.sessionId === sessionId) return role;
  }
  return null;
}
