/**
 * Task persistence helpers — Phase 3C dual-write bridge.
 *
 * Routes call these to keep the in-memory store and the Postgres `tasks`
 * table in sync. Reads prefer the DB (post-cutover authoritative source)
 * but fall back to the store so handlers can surface tasks created by
 * non-route code paths still on `store.ts` (the 14 consumers Phase 4
 * migrates: mutations.ts, lifecycle.ts, ceo.ts, etc.).
 *
 * Same code-quality pattern as IDEMPOTENCY_FAILURES: claim outcomes from
 * the CAS repo dispatch through a typed table so call sites don't
 * redeclare ErrorCause / RetrySafety / status code literals.
 */
import type { Task as ContractTask } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import postgres from "postgres";
import { observability } from "@arceus/contracts";
import { getSnapshot } from "../../persistence/store.js";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import { persistCompany } from "../../persistence/company-persistence.js";
import { persistSprint } from "../../persistence/domain-persistence.js";
import type { ErrorCause, RetrySafety } from "./envelope.js";

/**
 * Pull the postgres SQLSTATE code out of a drizzle error so warn logs stay
 * one-line instead of dumping the entire failed SQL statement.
 *   23503 — foreign_key_violation        (parent row missing in DB; expected
 *           during dual-write when the test seeded only the in-memory store)
 *   23505 — unique_violation             (CAS race already resolved)
 *   23514 — check_violation              (status / kind / priority constraint)
 */
function pgErrorCode(err: unknown): string {
  // Drizzle wraps the underlying driver error; the real PostgresError is at .cause.
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

/**
 * DB-first read with in-memory fallback. The store fallback is temporary —
 * Phase 4 migrates the remaining writers off `store.ts`, after which this
 * function collapses to a single DB call.
 */
export async function readTaskHybrid(taskId: string): Promise<ContractTask | null> {
  try {
    const fromDb = await tasksRepo.findByIdHydrated(getDb(), taskId);
    if (fromDb) return fromDb;
  } catch (err) {
    // DB unavailable / not migrated — fall through to store.
    console.warn(`[tasks] DB read skipped for ${taskId} (pg=${pgErrorCode(err)})`);
  }
  return getSnapshot().tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Persist the current store state for a task to the DB. Called after every
 * route mutation so the DB stays in sync. Errors are logged but never thrown
 * — the store is still authoritative until Phase 4 completes the cutover.
 */
export async function persistTask(taskId: string): Promise<void> {
  const task = getSnapshot().tasks.find((t) => t.id === taskId);
  if (!task) {
    if (process.env.ARCEUS_DEBUG_PERSIST === "1") console.log(`[persist:tasks] miss id=${taskId}`);
    return;
  }
  try {
    await tasksRepo.upsertTask(getDb(), task);
    if (process.env.ARCEUS_DEBUG_PERSIST === "1") console.log(`[persist:tasks] ok id=${taskId}`);
  } catch (err) {
    const code = pgErrorCode(err);
    // 23503 = parent row missing. Backfill company + sprint then retry once.
    // Same self-healing pattern as domain-persistence.persistTask — both
    // copies must heal because both can be the first writer to hit a stale
    // FK after a race during applyStrategy / sprint_create.
    if (code === "23503") {
      await persistCompany(task.companyId);
      if (task.sprintId) {
        const sprint = await sprintsRepo.findByIdHydrated(getDb(), task.sprintId);
        if (sprint) await persistSprint(sprint);
      }
      try {
        await tasksRepo.upsertTask(getDb(), task);
        if (process.env.ARCEUS_DEBUG_PERSIST === "1") console.log(`[persist:tasks] ok id=${taskId} (after backfill)`);
        return;
      } catch (retryErr) {
        const retryCode = pgErrorCode(retryErr);
        console.log(`[persist:tasks] skip pg=${retryCode} id=${taskId} (after backfill)`);
        observability.logEvent({
          event: "persist.failed",
          table: "tasks",
          id: taskId,
          pgCode: retryCode,
          ts: Date.now(),
        });
        return;
      }
    }
    console.log(`[persist:tasks] skip pg=${code} id=${taskId}`);
    observability.logEvent({
      event: "persist.failed",
      table: "tasks",
      id: taskId,
      pgCode: code,
      ts: Date.now(),
    });
  }
}

// ── CAS claim outcome → typed failure dispatch ───────────────────
//
// `tasksRepo.claimTask` returns one of four causes. Map each to the API's
// failure envelope here, in one place, so routes don't redeclare status
// codes / retry policies / human messages at every claim site.

interface ClaimFailureSpec {
  cause: ErrorCause;
  status: number;
  summaryFor: (taskId: string) => string;
  retry: RetrySafety;
  stopWhen: string;
}

export const CLAIM_FAILURES = {
  not_found: {
    cause: "not_found",
    status: 404,
    summaryFor: (id: string) => `Task ${id} not found.`,
    retry: "never",
    stopWhen: "resource_created",
  },
  already_claimed: {
    cause: "task_not_claimable",
    status: 409,
    summaryFor: (id: string) =>
      `Task ${id} is already claimed by another beat.`,
    retry: "never",
    stopWhen: "wait_for_release_or_completion",
  },
  not_claimable: {
    cause: "task_not_claimable",
    status: 409,
    summaryFor: (id: string) =>
      `Task ${id} is not in a claimable state (created/planned/ready).`,
    retry: "never",
    stopWhen: "wait_for_status_change",
  },
  wrong_role: {
    cause: "governance",
    status: 403,
    summaryFor: (id: string) =>
      `Task ${id} is assigned to a different role.`,
    retry: "never",
    stopWhen: "claim_own_role_task",
  },
} as const satisfies Record<string, ClaimFailureSpec>;

export type ClaimFailureKind = keyof typeof CLAIM_FAILURES;
