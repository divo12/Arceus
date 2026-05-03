/**
 * Task mutations — Spec 31 Phase 7.C.d / Spec 34 v3 PR 10.
 *
 * Canonical-direct write path for tasks. Read-modify-write helpers run
 * inside `db.transaction()` with a `lockForUpdate` row lock at the top
 * (Audit C8 / Spec 33 Pattern A).
 */
import type { Task, TaskProgress } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";

/** Insert or replace a task. */
export async function upsertTask(task: Task): Promise<Task> {
  await tasksRepo.upsertTask(getDb(), task);
  return task;
}

/**
 * Read-modify-write for a task. Returns the new task on success, null
 * if the task doesn't exist.
 *
 * Audit C8 (F-104/F-256): wrapped in `db.transaction()` so the read +
 * write commit atomically.
 *
 * Spec 33 / Audit C1: `tasksRepo.lockForUpdate` takes a row lock at
 * the top of the transaction, so two concurrent writers serialize on
 * this row instead of both reading the same baseline and producing
 * conflicting writes (last-write-wins lost update).
 */
export async function updateTask(
  taskId: string,
  updater: (task: Task) => Task,
): Promise<Task | null> {
  return await getDb().transaction(async (tx) => {
    await tasksRepo.lockForUpdate(tx, taskId);
    const current = await tasksRepo.findByIdHydrated(tx, taskId);
    if (!current) return null;
    const next = updater(current);
    await tasksRepo.upsertTask(tx, next);
    return next;
  });
}

// ─── Task progress (in-memory only) ───────────────────────────────
//
// Per-beat plan steps + commands are tracked in memory for the
// dashboard's progress widget. Not durable — restart loses them, and
// that's the intended behavior. If the dashboard ever needs durable
// progress it should be a canonical schema, not part of this map.

const taskProgressMap = new Map<string, TaskProgress>();

export function updateTaskProgress(taskId: string, progress: TaskProgress): void {
  taskProgressMap.set(taskId, progress);
}
