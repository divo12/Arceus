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

const LEARNINGS_LIMIT = 8;
const PATTERNS_LIMIT = 6;
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

/**
 * Merge new entries into an agent's role-level KNOWLEDGE memory.
 *
 * Continuity fields (currentFocus / openBlockers) are deliberately NOT writable
 * here — per-task focus + blockers now live in the task heartbeat, so role memory
 * carries only knowledge that outlives a single task. The stored continuity
 * columns are left untouched (inert).
 */
export async function enrichRoleMemory(
  companyId: string,
  role: AgentIdentity["role"],
  update: {
    recentLearnings?: string[];
    activePatterns?: string[];
    importantDecisions?: string[];
  },
  db: DbClient = getDb(),
): Promise<void> {
  await mutateRoleMemory(companyId, role, (memory) => ({
    ...memory,
    recentLearnings: update.recentLearnings
      ? uniqueStrings([...update.recentLearnings, ...memory.recentLearnings], LEARNINGS_LIMIT)
      : memory.recentLearnings,
    activePatterns: update.activePatterns
      ? uniqueStrings([...update.activePatterns, ...memory.activePatterns], PATTERNS_LIMIT)
      : memory.activePatterns,
    importantDecisions: update.importantDecisions
      ? uniqueStrings([...update.importantDecisions, ...memory.importantDecisions], DECISIONS_LIMIT)
      : memory.importantDecisions,
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
