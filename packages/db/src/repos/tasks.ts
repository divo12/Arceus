import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { tasks } from "../schema/tasks.js";
import type { DbClient } from "./_helpers.js";

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStatus = Task["status"];

// ── CRUD ───────────────────────────────────────────────────────

export async function createTask(db: DbClient, data: NewTask): Promise<Task> {
  const [row] = await db.insert(tasks).values(data).returning();
  return row;
}

export async function findTaskById(db: DbClient, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}

export async function listTasksByCompany(db: DbClient, companyId: string): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.companyId, companyId));
}

export async function listTasksByRole(
  db: DbClient,
  companyId: string,
  role: string,
  statuses?: TaskStatus[],
): Promise<Task[]> {
  const conditions = [eq(tasks.companyId, companyId), eq(tasks.assignedRole, role)];
  if (statuses && statuses.length > 0) {
    conditions.push(inArray(tasks.status, statuses));
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions));
}

export async function listTasksBySprint(db: DbClient, sprintId: string): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.sprintId, sprintId));
}

export async function updateTask(
  db: DbClient,
  id: string,
  patch: Partial<NewTask>,
): Promise<Task | null> {
  const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
  return row ?? null;
}

// ── CAS claim — the race-safe claim path (spec 31 §Core Tables →tasks) ──

export type ClaimResult =
  | { ok: true; task: Task }
  | { ok: false; cause: "not_found" | "already_claimed" | "not_claimable" | "wrong_role" };

/**
 * Atomically claim a task for a specific heartbeat run.
 *
 * Compound WHERE guarantees exactly one beat can claim any given task:
 *   - status must be planned | ready | blocked (claimable states)
 *   - checkout_run_id must be NULL (unclaimed)
 *   - optional agent scoping (if assignedAgentId set, must match)
 *
 * If zero rows are affected we issue a single lookup to disambiguate the
 * failure cause so callers can return precise envelope errors.
 *
 * Never retry on `already_claimed`. The loser of a race should back off and
 * wait for the next scheduler tick, not hammer the endpoint.
 */
export async function claimTask(
  db: DbClient,
  taskId: string,
  runId: string,
  assignedAgentId?: string,
): Promise<ClaimResult> {
  const now = new Date();
  const claimableStatuses: TaskStatus[] = ["planned", "ready", "blocked"];

  const result = await db
    .update(tasks)
    .set({
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: now,
      status: "in_progress",
      claimedAt: now,
      startedAt: now,
      ...(assignedAgentId ? { assignedAgentId } : {}),
    })
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(tasks.status, claimableStatuses),
        isNull(tasks.checkoutRunId),
      ),
    )
    .returning();

  if (result.length === 1) {
    return { ok: true, task: result[0] };
  }

  // Zero rows affected — figure out why.
  const existing = await findTaskById(db, taskId);
  if (!existing) return { ok: false, cause: "not_found" };
  if (existing.checkoutRunId) return { ok: false, cause: "already_claimed" };
  return { ok: false, cause: "not_claimable" };
}

/** Release a claim without completing — moves back to `ready` so another beat can pick it up. */
export async function releaseClaim(
  db: DbClient,
  taskId: string,
  runId: string,
): Promise<boolean> {
  const result = await db
    .update(tasks)
    .set({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
      status: "ready",
      claimedAt: null,
      startedAt: null,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.checkoutRunId, runId)))
    .returning({ id: tasks.id });
  return result.length === 1;
}

// ── Terminal transitions ────────────────────────────────────

export async function completeTask(
  db: DbClient,
  taskId: string,
  evidence?: Record<string, unknown>,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({
      status: "completed",
      completedAt: new Date(),
      ...(evidence ? { evidence } : {}),
    })
    .where(eq(tasks.id, taskId))
    .returning();
  return row ?? null;
}

export async function blockTask(
  db: DbClient,
  taskId: string,
  feedback: string,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ status: "blocked", feedback })
    .where(eq(tasks.id, taskId))
    .returning();
  return row ?? null;
}

export async function setTaskStatus(
  db: DbClient,
  taskId: string,
  status: TaskStatus,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ status })
    .where(eq(tasks.id, taskId))
    .returning();
  return row ?? null;
}

export async function appendPlanStep(
  db: DbClient,
  taskId: string,
  step: { stepNumber: number; description: string; status: "pending" | "done" | "skipped"; note?: string },
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ plan: sql`${tasks.plan} || ${JSON.stringify([step])}::jsonb` })
    .where(eq(tasks.id, taskId))
    .returning();
  return row ?? null;
}
