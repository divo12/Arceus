/**
 * Internal System Agent Registry — Spec 24
 *
 * Internal agents are invisible to the board/dashboard but have full agent identity:
 * - OpenCode session (same session model as org-chart roles)
 * - Agent identity registered in agentSessions with `_internal/` prefix
 * - Hippocampus memory access, tool access, audit trail
 *
 * They do NOT appear in org chart, ROLE_SOULS, or public company snapshot.
 */

// ── Types ───────────────────────────────────────────────────

export interface InternalAgentDefinition {
  /** Stable key — used as session map key and agent identity */
  key: string;
  /** Display name for audit logs */
  name: string;
  /** System prompt — the agent's reasoning instructions */
  systemPrompt: string;
  /** Deployment model key */
  deployment: "ceoDeployment" | "workerDeployment";
  /** Whether this agent persists its session across beats */
  sessionPersistence: "per-beat" | "per-sprint" | "singleton";
  /** Tools this agent can call (Spec 23 plugin tools) */
  allowedTools: string[];
}

// ── System Prompts ──────────────────────────────────────────

const FACILITATOR_AGENT_SYSTEM_PROMPT = `You are the Facilitator Agent. You analyze and resolve Arceus company meetings after contributions have been collected from all participants.

You operate in 3 phases within a single session:

Phase 1 — SYNTHESIZE: You receive all agent contributions. Detect conflicts between agents, blockers preventing progress, alignment issues, and highlights. Flag items requiring board attention. Be specific — cite which agents are in conflict and why.

Phase 2 — RESOLVE: For each conflict and blocker you identified, decide an action: create_task, modify_task, escalate_to_board, note, or no_action. Use the arceus_record_meeting tool to persist decisions. Use arceus_create_task for new tasks.

Phase 3 — BRIEF: Generate a concise daily sync brief summarizing company status, team updates, active blockers, upcoming dependencies, and the decisions you just made.

You have full context continuity. Phase 2 sees your Phase 1 reasoning. Phase 3 sees everything.`;

// ── Registry ────────────────────────────────────────────────

export const INTERNAL_AGENTS: Record<string, InternalAgentDefinition> = {
  facilitator_agent: {
    key: "facilitator_agent",
    name: "Synth",
    systemPrompt: FACILITATOR_AGENT_SYSTEM_PROMPT,
    deployment: "ceoDeployment",
    sessionPersistence: "per-beat",
    allowedTools: ["arceus_record_meeting", "arceus_create_task"],
  },
};

// ── Helpers ─────────────────────────────────────────────────

/** Build the `_internal/{key}` role string used in agentSessions */
export function internalAgentRole(key: string): string {
  return `_internal/${key}`;
}

/** Check whether a role string belongs to an internal agent */
export function isInternalAgentRole(role: string): boolean {
  return role.startsWith("_internal/");
}

/** Get the internal agent key from a `_internal/{key}` role string */
export function internalAgentKeyFromRole(role: string): string | null {
  if (!role.startsWith("_internal/")) return null;
  return role.slice("_internal/".length);
}

/** Get an internal agent definition by key. Throws if unknown. */
export function getInternalAgent(key: string): InternalAgentDefinition {
  const def = INTERNAL_AGENTS[key];
  if (!def) throw new Error(`Unknown internal agent: ${key}`);
  return def;
}
