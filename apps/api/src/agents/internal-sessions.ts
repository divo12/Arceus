/**
 * Internal Agent Session Management — Spec 24
 *
 * Creates and manages OpenCode sessions for internal system agents
 * (Memory Agent, Facilitator Agent, Skill Evolution Agent).
 * Sessions are stored in the shared `agentSessions` map with `_internal/` prefix.
 */

import { getInternalAgent, internalAgentRole } from "@arceus/company-runtime";
import { nowIso } from "@arceus/task-engine";
import { getOpencode } from "../infra/opencode.js";
import { agentSessions, type AgentSessionState } from "../orchestration/state.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { swallowAndAudit } from "../observability/swallow.js";

/**
 * Get or create an OpenCode session for an internal agent.
 * Sessions are keyed by `_internal/{agentKey}` in the agentSessions map.
 */
export async function ensureInternalAgentSession(
  agentKey: string,
): Promise<AgentSessionState> {
  const def = getInternalAgent(agentKey);
  const role = internalAgentRole(agentKey);

  const existing = agentSessions.get(role);
  if (existing) return existing;

  const opencode = await getOpencode();
  const session = await opencode.client.session.create({
    body: { title: `Internal: ${def.name} (${agentKey})` },
  });

  if (!session.data) {
    throw new Error(`Failed to create session for internal agent: ${agentKey}`);
  }

  const state: AgentSessionState = {
    role,
    agentId: `internal-${agentKey}`,
    sessionId: session.data.id,
    name: def.name,
    status: "idle",
    lastEventAt: nowIso(),
    lastEventType: "session.created",
    lastEventSummary: `Internal agent session created for ${def.name}`,
    lastToolName: null,
    lastToolStatus: null,
    lastToolAt: null,
    lastProgressAt: null,
    lastWorkspaceChangeAt: null,
    awaiting: "idle",
    activeTaskId: null,
    promptStartedAt: null,
    promptCompletedAt: null,
    eventCount: 0,
    toolInvocationCount: 0,
    fileEditCount: 0,
    shellCommandCount: 0,
    stallReason: null,
  };

  agentSessions.set(role, state);
  emitEmployeeActivity(role as any, "info", `Internal agent session created for ${def.name}`);
  return state;
}

/**
 * Destroy all internal agent sessions. Called during beat cleanup.
 */
export async function destroyInternalAgentSessions(): Promise<void> {
  const { destroyBeatSession } = await import("../infra/opencode.js");

  for (const [role, session] of agentSessions) {
    if (role.startsWith("_internal/")) {
      swallowAndAudit("internal_session.destroy", () => destroyBeatSession(session.sessionId),
        { agentRole: role, detail: { sessionId: session.sessionId } });
      agentSessions.delete(role);
    }
  }
}
