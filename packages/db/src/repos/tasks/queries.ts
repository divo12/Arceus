/**
 * Tasks repo — read queries.
 * Spec 34 v3 PR 6.
 */
import { and, eq, inArray } from "drizzle-orm";
import { tasks } from "../../schema/tasks.js";
import type { DbClient } from "../_helpers.js";
import { toDbId } from "./ids.js";
import type { Task, TaskStatus } from "./ids.js";

export async function findTaskById(db: DbClient, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function listTasksByCompany(db: DbClient, companyId: string): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.companyId, toDbId(companyId)));
}

/**
 * Spec 31 Phase 7 — count tasks for a company filtered by `kind` +
 * `status`. Used by the execution-cycle "queued follow-ups" gate.
 * Returns a count rather than rows because callers don't need the
 * payload.
 */
export async function countTasksByKindAndStatus(
  db: DbClient,
  companyId: string,
  kind: string,
  statuses: TaskStatus[],
): Promise<number> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, toDbId(companyId)),
        eq(tasks.kind, kind),
        inArray(tasks.status, statuses),
      ),
    );
  return rows.length;
}
