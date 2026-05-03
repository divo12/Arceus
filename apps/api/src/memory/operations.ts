/**
 * Agent memory read/write operations: focus updates, enrichment,
 * blocker clearing, and prompt formatting. Spec 31 Phase 7.B.1 — DB-direct,
 * no in-memory snapshot.
 */

import type { AgentIdentity, MemorySummary } from "@arceus/contracts";
import type { PreparedAgentContext } from "@arceus/hippocampus";
import { uniqueStrings } from "@arceus/task-engine";
import { getDb, type DbClient } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as memorySummariesRepo from "@arceus/db/src/repos/memory_summaries.js";

const FOCUS_LIMIT = 6;
const LEARNINGS_LIMIT = 8;
const PATTERNS_LIMIT = 6;
const BLOCKERS_LIMIT = 6;
const DECISIONS_LIMIT = 8;

/** Default summary used when an agent has no memory_summaries row yet. */
function emptyMemory(agentId: string): MemorySummary {
  return {
    id: `memory_${agentId}`,
    agentId,
    currentFocus: [],
    recentLearnings: [],
    activePatterns: [],
    openBlockers: [],
    importantDecisions: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Read-modify-write the agent's memory summary. Resolves the agent
 * by `(companyId, role)`, fetches the current summary (or starts
 * fresh), applies `updater`, persists via `upsertSummary`. Returns
 * the persisted contract row, or `null` if no agent matches.
 */
async function mutateRoleMemory(
  companyId: string,
  role: AgentIdentity["role"],
  updater: (memory: MemorySummary) => MemorySummary,
  db: DbClient = getDb(),
): Promise<MemorySummary | null> {
  const agent = await agentsRepo.findAgentByRole(db, companyId, role);
  if (!agent) return null;

  const current = await memorySummariesRepo.findByAgentHydrated(db, agent.id) ?? emptyMemory(agent.id);
  const next = updater(current);
  await memorySummariesRepo.upsertSummary(db, next, companyId);
  return next;
}

/** Replace an agent's currentFocus memory with the given entries. */
export async function updateRoleMemory(
  companyId: string,
  role: AgentIdentity["role"],
  currentFocus: string[],
  db: DbClient = getDb(),
): Promise<void> {
  await mutateRoleMemory(companyId, role, (memory) => ({
    ...memory,
    currentFocus: uniqueStrings(currentFocus, FOCUS_LIMIT),
    updatedAt: new Date().toISOString(),
  }), db);
}

/** Merge new entries into an agent's memory fields. */
export async function enrichRoleMemory(
  companyId: string,
  role: AgentIdentity["role"],
  update: {
    currentFocus?: string[];
    recentLearnings?: string[];
    activePatterns?: string[];
    openBlockers?: string[];
    importantDecisions?: string[];
  },
  db: DbClient = getDb(),
): Promise<void> {
  await mutateRoleMemory(companyId, role, (memory) => ({
    ...memory,
    currentFocus: update.currentFocus
      ? uniqueStrings([...update.currentFocus, ...memory.currentFocus], FOCUS_LIMIT)
      : memory.currentFocus,
    recentLearnings: update.recentLearnings
      ? uniqueStrings([...update.recentLearnings, ...memory.recentLearnings], LEARNINGS_LIMIT)
      : memory.recentLearnings,
    activePatterns: update.activePatterns
      ? uniqueStrings([...update.activePatterns, ...memory.activePatterns], PATTERNS_LIMIT)
      : memory.activePatterns,
    openBlockers: update.openBlockers
      ? uniqueStrings([...update.openBlockers, ...memory.openBlockers], BLOCKERS_LIMIT)
      : memory.openBlockers,
    importantDecisions: update.importantDecisions
      ? uniqueStrings([...update.importantDecisions, ...memory.importantDecisions], DECISIONS_LIMIT)
      : memory.importantDecisions,
    updatedAt: new Date().toISOString(),
  }), db);
}

/** Remove specific blockers from an agent's openBlockers list. */
export async function clearRoleBlockers(
  companyId: string,
  role: AgentIdentity["role"],
  blockersToClear: string[],
  db: DbClient = getDb(),
): Promise<void> {
  if (blockersToClear.length === 0) return;
  const normalized = new Set(blockersToClear.map((item) => item.trim()));
  await mutateRoleMemory(companyId, role, (memory) => ({
    ...memory,
    openBlockers: memory.openBlockers.filter((item) => !normalized.has(item.trim())),
    updatedAt: new Date().toISOString(),
  }), db);
}

/** Format a PreparedAgentContext into a human-readable prompt section. Pure. */
export function formatHippocampusContext(ctx: PreparedAgentContext): string {
  const sections: string[] = [];

  if (ctx.memories.length > 0) {
    sections.push(
      "# Your Memory (facts you remember from previous work)",
      ...ctx.memories.map((m) => `- ${m.content}`),
    );
  }

  if (ctx.habits.length > 0) {
    sections.push(
      "",
      "# Your Habits (behavioral patterns you've learned)",
      ...ctx.habits.map((h) => `- When: ${h.trigger} → Do: ${h.action}`),
    );
  }

  if (ctx.priming) {
    sections.push("", `# Disposition: ${ctx.priming}`);
  }

  return sections.length > 0 ? sections.join("\n") : "";
}
