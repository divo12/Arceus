import { eq, sql } from "drizzle-orm";
import type { MemorySummary as ContractMemorySummary } from "@arceus/contracts";
import { memorySummaries } from "../schema/memory_summaries.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type MemorySummary = typeof memorySummaries.$inferSelect;
export type NewMemorySummary = typeof memorySummaries.$inferInsert;

export const toDbId = friendlyToUuid;
export const fromDbId = (uuid: string, friendlyHint?: string | null): string => friendlyHint ?? uuid;

// ── DB row ↔ contracts.MemorySummary ───────────────────────

export function rowToSummary(row: MemorySummary): ContractMemorySummary {
  return {
    /** Domain id was `memory_${agentId}`; reconstruct deterministically. */
    id: `memory_${fromDbId(row.agentId)}`,
    agentId: fromDbId(row.agentId),
    currentFocus: row.currentFocus ?? [],
    recentLearnings: row.recentLearnings ?? [],
    activePatterns: row.activePatterns ?? [],
    openBlockers: row.openBlockers ?? [],
    importantDecisions: row.importantDecisions ?? [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function summaryToInsert(summary: ContractMemorySummary, companyId: string): NewMemorySummary {
  return {
    agentId: toDbId(summary.agentId),
    companyId: toDbId(companyId),
    currentFocus: summary.currentFocus,
    recentLearnings: summary.recentLearnings,
    activePatterns: summary.activePatterns,
    openBlockers: summary.openBlockers,
    importantDecisions: summary.importantDecisions,
  };
}

// ── Queries ────────────────────────────────────────────────

export async function findByAgent(db: DbClient, agentId: string): Promise<MemorySummary | null> {
  const [row] = await db
    .select()
    .from(memorySummaries)
    .where(eq(memorySummaries.agentId, toDbId(agentId)))
    .limit(1);
  return row ?? null;
}

// ── Row-level lock (Spec 33 — C1 Pattern A) ─────────────────────
//
// `SELECT agent_id … FOR UPDATE` row lock keyed on agentId (the PK).
// Serializes concurrent read-modify-write on this agent's memory
// summary inside a `db.transaction()`.
export async function lockByAgent(tx: DbClient, agentId: string): Promise<void> {
  await tx.execute(
    sql`SELECT agent_id FROM ${memorySummaries} WHERE agent_id = ${toDbId(agentId)} FOR UPDATE`,
  );
}

export async function findByAgentHydrated(db: DbClient, agentId: string): Promise<ContractMemorySummary | null> {
  const row = await findByAgent(db, agentId);
  return row ? rowToSummary(row) : null;
}

export async function listByCompany(db: DbClient, companyId: string): Promise<MemorySummary[]> {
  return db.select().from(memorySummaries).where(eq(memorySummaries.companyId, toDbId(companyId)));
}

/** Insert or overwrite the agent's summary. PK is `agent_id`. */
export async function upsertSummary(
  db: DbClient,
  summary: ContractMemorySummary,
  companyId: string,
): Promise<MemorySummary> {
  const insert = summaryToInsert(summary, companyId);
  const [row] = await db
    .insert(memorySummaries)
    .values(insert)
    .onConflictDoUpdate({
      target: memorySummaries.agentId,
      set: {
        currentFocus: insert.currentFocus,
        recentLearnings: insert.recentLearnings,
        activePatterns: insert.activePatterns,
        openBlockers: insert.openBlockers,
        importantDecisions: insert.importantDecisions,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}
