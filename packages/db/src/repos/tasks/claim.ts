/**
 * Tasks repo — CAS claim path and row-level locks.
 * Spec 34 v3 PR 6.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { tasks } from "../../schema/tasks.js";
import type { DbClient } from "../_helpers.js";
import { toDbId } from "./ids.js";
import type { Task, TaskStatus } from "./ids.js";
import { findTaskById } from "./queries.js";

// ── CAS claim — the race-safe claim path (spec 31 §Core Tables → tasks) ──

export type ClaimResult =
  | { ok: true; task: Task }
  | { ok: false; cause: "not_found" | "already_claimed" | "not_claimable" | "wrong_role" };

/**
 * Atomically claim a task for a specific heartbeat run.
 *
 * Compound WHERE guarantees exactly one beat can claim any given task:
 *   - status must be created | planned | ready (claimable states; aligned with the
 *     `tasks.routes.ts` claim handler, which rejects `blocked` because a blocked
 *     task needs explicit unblocking before re-claim)
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
  // `blocked` is included so the assigned role can self-retry a task
  // they previously gave up on — common after a hallucinated
  // task_block (gpt-5.4-mini fabricates an error reason then bails).
  // The role gate at the route layer (tasks.routes.ts:515) ensures
  // only the same assignee can re-claim; cross-role re-claim returns
  // `wrong_role` before we get here. The DB CAS still atomically
  // flips the row to in_progress, so two concurrent re-claim attempts
  // resolve to exactly one winner — same race-safety as a fresh claim.
  const claimableStatuses: TaskStatus[] = ["created", "planned", "ready", "blocked"];
  const dbTaskId = toDbId(taskId);
  const dbRunId = toDbId(runId);
  const dbAgentId = assignedAgentId ? toDbId(assignedAgentId) : undefined;

  const result = await db
    .update(tasks)
    .set({
      checkoutRunId: dbRunId,
      executionRunId: dbRunId,
      executionLockedAt: now,
      status: "in_progress",
      claimedAt: now,
      startedAt: now,
      ...(dbAgentId ? { assignedAgentId: dbAgentId } : {}),
    })
    .where(
      and(
        eq(tasks.id, dbTaskId),
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

/** Release a claim without completing — moves back to `planned` so another beat can pick it up. */
export async function releaseClaim(
  db: DbClient,
  taskId: string,
  runId: string,
): Promise<boolean> {
  // Released tasks land in `planned` (Zod taskStatusSchema) — the in-memory
  // store sets the same value (see run-beat.ts), so DB + snapshot agree.
  // The legacy `ready` value was DB-only and would Zod-fail on hydration.
  const result = await db
    .update(tasks)
    .set({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
      status: "planned",
      claimedAt: null,
      startedAt: null,
    })
    .where(and(eq(tasks.id, toDbId(taskId)), eq(tasks.checkoutRunId, toDbId(runId))))
    .returning({ id: tasks.id });
  return result.length === 1;
}

/**
 * Release every in-progress claim held by a given beat/run. Used by the
 * run-beat cleanup path when a beat dies mid-flight (e.g. fetch-failed
 * during a long opencode prompt) so the orphaned task doesn't stay locked
 * to a dead beat. Vision §11 — beats should not leak claims.
 *
 * Returns friendly id hints if present in body.friendlyIds, else uuids.
 */
export async function releaseClaimsForBeat(
  db: DbClient,
  beatId: string,
): Promise<string[]> {
  const dbRunId = toDbId(beatId);
  // Same `planned` rationale as releaseClaim — match Zod taskStatusSchema +
  // the in-memory store mutation in run-beat.ts so DB + snapshot agree.
  const released = await db
    .update(tasks)
    .set({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
      status: "planned",
      claimedAt: null,
      startedAt: null,
    })
    .where(and(eq(tasks.checkoutRunId, dbRunId), eq(tasks.status, "in_progress")))
    .returning({ id: tasks.id, body: tasks.body });
  return released.map((r) => {
    // tasks.body is jsonb; narrow to the friendlyIds shape we wrote.
    const body = r.body as { friendlyIds?: { id?: unknown } } | null;
    const fid = body?.friendlyIds?.id;
    return typeof fid === "string" ? fid : r.id;
  });
}

// ── Concurrency Phase B — claim ownership check ─────────────────
//
// Returns true if the task is currently claimed by `beatId`, false if
// it's claimed by someone else, unclaimed, or doesn't exist.
//
// Used by the route handlers for state-mutating tools (task_complete,
// task_block, task_verify, task_set_preview_url) to refuse late tool
// calls from a stranded beat whose claim has already been released by
// `releaseClaimsForBeat`. Without this check, a dead beat's lingering
// HTTP request could complete a task another beat now legitimately
// owns — silent corruption that the orchestrator can't unwind.
//
// Read-only (no row lock). Acceptable because the worst case is a
// false-negative TOCTOU window between this check and the subsequent
// state mutation: a task reclaimed in that window proceeds to mutate
// against the new owner. The state mutation itself uses lockForUpdate
// inside a transaction, so the actual write is still atomic — this
// helper only filters out the obvious wrong-owner cases.

export async function isTaskClaimedBy(
  db: DbClient,
  taskId: string,
  beatId: string,
): Promise<boolean> {
  const expected = toDbId(beatId);
  const [row] = await db
    .select({ checkoutRunId: tasks.checkoutRunId })
    .from(tasks)
    .where(eq(tasks.id, toDbId(taskId)))
    .limit(1);
  return row?.checkoutRunId === expected;
}

// ── Row-level lock (Spec 33 — C1 Pattern A) ─────────────────────
//
// Take a `SELECT id FROM tasks WHERE id = ? FOR UPDATE` row lock so a
// surrounding `db.transaction()` serializes concurrent read-modify-
// write callers on this task. Without this, two transactions both
// read the same baseline row and produce conflicting writes (last-
// write-wins lost update).
//
// Must be called inside a transaction — calling on `db` directly
// releases the lock at statement end and provides no protection.
//
// Reference: Paperclip services/issues.ts:1329 — same pattern for
// `clearExecutionRunIfTerminal`'s read-validate-write closure.
export async function lockForUpdate(tx: DbClient, taskId: string): Promise<void> {
  await tx.execute(
    sql`SELECT id FROM ${tasks} WHERE id = ${toDbId(taskId)} FOR UPDATE`,
  );
}
