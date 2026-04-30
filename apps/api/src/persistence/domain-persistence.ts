/**
 * Sprint + task row persistence — DB-only.
 *
 * Each `persistX(entity)` upserts a single row to canonical via the
 * matching repo. Postgres is the source of truth; there is no in-memory
 * shadow to converge against.
 *
 * Errors are logged + swallowed so route responses are never blocked.
 * FK violations (23503) trigger a one-shot parent backfill + retry —
 * this self-heals the bootstrap race where governance tasks land before
 * `applyStrategy`'s fire-and-forget company/sprint upsert finishes.
 */
import { getDb } from "@arceus/db";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import postgres from "postgres";
import { observability } from "@arceus/contracts";
import type { Sprint, Task } from "@arceus/contracts";
import { persistCompany } from "./company-persistence.js";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

function pgErrorDetail(err: unknown): string {
  const e = err instanceof postgres.PostgresError
    ? err
    : (err instanceof Error && err.cause instanceof postgres.PostgresError)
      ? err.cause
      : null;
  if (!e) return "";
  return `constraint=${e.constraint_name ?? "?"} detail=${e.detail ?? "?"} table=${e.table_name ?? "?"} column=${e.column_name ?? "?"}`;
}

/**
 * Set `ARCEUS_DEBUG_PERSIST=1` to also log successful writes (useful when
 * diagnosing FK ordering races); errors are always logged so persistence
 * failures never go silent.
 */
const PERSIST_DEBUG = process.env.ARCEUS_DEBUG_PERSIST === "1";
function logPersist(
  table: string,
  id: string,
  outcome: "ok" | "skip",
  err?: unknown,
): void {
  if (outcome === "ok" && !PERSIST_DEBUG) return;
  if (outcome === "skip") {
    const code = pgErrorCode(err);
    const detail = pgErrorDetail(err);
    console.log(`[persist:${table}] skip pg=${code} id=${id}${detail ? ` ${detail}` : ""}`);
    observability.logEvent({
      event: "persist.failed",
      table,
      id,
      pgCode: code,
      ts: Date.now(),
    });
    return;
  }
  console.log(`[persist:${table}] ${outcome} id=${id}`);
}

// ── Sprints ───────────────────────────────────────────────────

export async function persistSprint(sprint: Sprint): Promise<void> {
  try {
    await sprintsRepo.upsertSprint(getDb(), sprint);
    logPersist("sprints", sprint.id, "ok");
  } catch (err) {
    const code = pgErrorCode(err);
    // FK violation → parent company row missing. Backfill once and retry.
    if (code === "23503") {
      await persistCompany(sprint.companyId);
      try {
        await sprintsRepo.upsertSprint(getDb(), sprint);
        logPersist("sprints", sprint.id, "ok");
        return;
      } catch (retryErr) {
        logPersist("sprints", sprint.id, "skip", retryErr);
        return;
      }
    }
    logPersist("sprints", sprint.id, "skip", err);
  }
}

// ── Tasks ─────────────────────────────────────────────────────

export async function persistTask(task: Task): Promise<void> {
  try {
    await tasksRepo.upsertTask(getDb(), task);
    logPersist("tasks", task.id, "ok");
  } catch (err) {
    const code = pgErrorCode(err);
    // 23503 = parent missing. Tasks FK both companies and sprints; backfill
    // both before retrying.
    if (code === "23503") {
      await persistCompany(task.companyId);
      if (task.sprintId) {
        const sprint = await sprintsRepo.findByIdHydrated(getDb(), task.sprintId);
        if (sprint) await persistSprint(sprint);
      }
      try {
        await tasksRepo.upsertTask(getDb(), task);
        logPersist("tasks", task.id, "ok");
        return;
      } catch (retryErr) {
        logPersist("tasks", task.id, "skip", retryErr);
        return;
      }
    }
    logPersist("tasks", task.id, "skip", err);
  }
}
