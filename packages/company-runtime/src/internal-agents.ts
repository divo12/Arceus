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

import { FACILITATOR_AGENT_SYSTEM_PROMPT } from "@arceus/prompts";

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
