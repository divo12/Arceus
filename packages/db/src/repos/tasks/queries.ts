/**
 * Tasks repo — read queries.
 * Spec 34 v3 PR 6.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
/**
 * Pre-flight claimability check used by the heartbeat scheduler tick
 * to skip beats for roles that have no work to do.
 *
 * "Claimable" here means: unclaimed AND (
 *   status = planned  — sprint creation promotes no-dep tasks to planned,
 *                       so planned reliably means deps are met, OR
 *   status = created  AND depends_on_task_ids is empty — tasks that were
 *                       not yet promoted but have no blocking deps.
 * )
 *
 * `created` tasks with non-empty depends_on_task_ids are excluded: they
 * are waiting on upstream work. Without this exclusion, such tasks make
 * the heartbeat engine always wake the agent (LLM path), while the
 * checklist path — which creates "Fix blocker" follow-ups — never fires.
 */
export async function hasClaimableTasksForRole(
  db: DbClient,
  companyId: string,
  role: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, toDbId(companyId)),
        eq(tasks.assignedRole, role),
        isNull(tasks.checkoutRunId),
        or(
          eq(tasks.status, "planned" as TaskStatus),
          and(
            eq(tasks.status, "created" as TaskStatus),
            sql`cardinality(${tasks.dependsOnTaskIds}) = 0`,
          ),
          // blocked/failed tasks owned by this role must WAKE the role:
          // the blocked-task repair path (checkSprintHealth → spawn
          // "Fix blocker" follow-up) lives in the beat's checklist
          // phase, which only runs if the beat fires at all. Without
          // this branch a company whose remaining tasks are blocked +
          // dependent-on-blocked deadlocks permanently (observed live:
          // tester blocked the QA task, CTO gate depended on it, no
          // role was ever woken again). The follow-up spawn is
          // idempotent, so steady-state cost is one checklist-only
          // beat per role interval while a blocker exists.
          inArray(tasks.status, ["blocked", "failed"] as TaskStatus[]),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

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
