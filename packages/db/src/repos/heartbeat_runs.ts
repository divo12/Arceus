import { and, eq, lt } from "drizzle-orm";
import { heartbeatRuns } from "../schema/heartbeat_runs.js";
import type { DbClient } from "./_helpers.js";

export type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
export type NewHeartbeatRun = typeof heartbeatRuns.$inferInsert;

export async function startRun(db: DbClient, data: NewHeartbeatRun): Promise<HeartbeatRun> {
  const [row] = await db.insert(heartbeatRuns).values(data).returning();
  return row;
}

export async function finishRun(
  db: DbClient,
  id: string,
  update: {
    status: "completed" | "failed";
    cause?: string;
    verdictScore?: number;
    verdictOutcome?: "pass" | "fail";
    verdictSignals?: Record<string, unknown>;
    totalTokens?: number;
    totalCostCents?: number;
    toolCallCount?: number;
  },
): Promise<HeartbeatRun | null> {
  const [row] = await db
    .update(heartbeatRuns)
    .set({ ...update, finishedAt: new Date() })
    .where(eq(heartbeatRuns.id, id))
    .returning();
  return row ?? null;
}

export async function findRunById(db: DbClient, id: string): Promise<HeartbeatRun | null> {
  const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).limit(1);
  return row ?? null;
}

/** Find runs still marked 'running' but older than `minStalledMs` — candidates for reconciliation. */
export async function findStrandedRuns(
  db: DbClient,
  minStalledMs = 30 * 60 * 1000,
): Promise<HeartbeatRun[]> {
  const cutoff = new Date(Date.now() - minStalledMs);
  return db
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.status, "running"), lt(heartbeatRuns.startedAt, cutoff)));
}

/**
 * Find every still-`running` row for a specific company, regardless of
 * age. Used by the active-company switch path to mark beats from the
 * departing company stranded immediately — they cannot be productive
 * anymore since the active-company seam is single-tenant.
 */
export async function findRunningRunsForCompany(
  db: DbClient,
  companyId: string,
): Promise<HeartbeatRun[]> {
  return db
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.companyId, companyId)));
}

export async function markStranded(db: DbClient, id: string, reason: string): Promise<HeartbeatRun | null> {
  const [row] = await db
    .update(heartbeatRuns)
    .set({ status: "stranded", cause: reason, finishedAt: new Date() })
    .where(eq(heartbeatRuns.id, id))
    .returning();
  return row ?? null;
}
