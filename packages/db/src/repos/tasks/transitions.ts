/**
 * Tasks repo — write-side transitions (status, evidence, feedback).
 * Spec 34 v3 PR 6.
 */
import { eq } from "drizzle-orm";
import { tasks } from "../../schema/tasks.js";
import type { DbClient } from "../_helpers.js";
import { toDbId } from "./ids.js";
import type { NewTask, Task, TaskStatus } from "./ids.js";

export async function updateTask(
  db: DbClient,
  id: string,
  patch: Partial<NewTask>,
): Promise<Task | null> {
  const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, toDbId(id))).returning();
  return row ?? null;
}

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
    .where(eq(tasks.id, toDbId(taskId)))
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
    .where(eq(tasks.id, toDbId(taskId)))
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
    .where(eq(tasks.id, toDbId(taskId)))
    .returning();
  return row ?? null;
}
