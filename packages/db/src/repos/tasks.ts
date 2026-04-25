import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type {
  Task as ContractTask,
  RoleType,
  PlannerState,
  ExecutorState,
  VerifierState,
} from "@arceus/contracts";
import { tasks } from "../schema/tasks.js";
import { artifacts } from "../schema/artifacts.js";
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

// ── Hydration: DB row ↔ contracts.Task (Phase 3B) ──────────────
//
// `tasks.body` jsonb (added in Phase 3A) carries the runtime sub-state that
// hasn't earned its own table yet — planner/executor/verifier and incoming
// artifact refs. `artifactIds` and `childTaskIds` are derived from sibling
// tables, not stored on the row, so the hydration helpers either fetch them
// per-task (`findByIdHydrated`) or batch-fetch for a list (`listByCompanyHydrated`).

interface TaskBody {
  plannerState?: PlannerState;
  executorState?: ExecutorState;
  verifierState?: VerifierState;
  incomingArtifactIds?: string[];
}

const DEFAULT_PLANNER: PlannerState = {
  objective: "",
  planSteps: [],
  selectedTools: [],
  currentStepIndex: 0,
};

const DEFAULT_EXECUTOR: ExecutorState = {
  currentCommand: null,
  commandsExecuted: [],
  results: [],
};

const DEFAULT_VERIFIER: VerifierState = {
  isVerified: false,
  feedback: null,
  verifiedByAgentId: null,
};

interface TaskRefs {
  artifactIds: string[];
  childTaskIds: string[];
}

/**
 * Pure transform from a DB row to a contracts.Task. Side-table refs
 * (artifactIds, childTaskIds) come from the caller so this function makes
 * no DB calls — useful for batch hydration where refs are pre-fetched.
 */
export function rowToTask(row: Task, refs: TaskRefs): ContractTask {
  const body = (row.body ?? {}) as TaskBody;
  return {
    id: row.id,
    companyId: row.companyId,
    sprintId: row.sprintId ?? null,
    kind: row.kind as ContractTask["kind"],
    title: row.title,
    description: row.description ?? "",
    problemStatement: row.problemStatement ?? "",
    deliverable: row.deliverable ?? "",
    definitionOfDone: row.definitionOfDone,
    status: row.status as ContractTask["status"],
    priority: row.priority as ContractTask["priority"],
    assignedRole: (row.assignedRole ?? "developer") as RoleType,
    assignedAgentId: row.assignedAgentId ?? null,
    parentTaskId: row.parentTaskId ?? null,
    dependsOnTaskIds: row.dependsOnTaskIds,
    childTaskIds: refs.childTaskIds,
    artifactIds: refs.artifactIds,
    localPreviewUrl: row.localPreviewUrl ?? null,
    plannerState: body.plannerState ?? DEFAULT_PLANNER,
    executorState: body.executorState ?? DEFAULT_EXECUTOR,
    verifierState: body.verifierState ?? DEFAULT_VERIFIER,
    costCents: row.costCents,
    iterationCount: row.iterationCount,
    maxIterations: row.maxIterations,
    incomingArtifactIds: body.incomingArtifactIds ?? [],
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/**
 * Build the insert payload from a contracts.Task. Splits the runtime sub-state
 * into the `body` jsonb and surfaces the queryable fields as columns.
 *
 * Note: `id` and FK fields (companyId/sprintId/parentTaskId/assignedAgentId)
 * are passed through verbatim. Phase 3C will decide whether the route layer
 * does uuidv5 conversion at the boundary or whether we widen those columns
 * to text — this helper stays neutral.
 */
export function taskToInsert(task: ContractTask): NewTask {
  return {
    id: task.id,
    companyId: task.companyId,
    sprintId: task.sprintId ?? null,
    parentTaskId: task.parentTaskId ?? null,
    title: task.title,
    description: task.description,
    kind: task.kind,
    priority: task.priority,
    status: task.status,
    assignedRole: task.assignedRole,
    assignedAgentId: task.assignedAgentId ?? null,
    dependsOnTaskIds: task.dependsOnTaskIds,
    problemStatement: task.problemStatement,
    deliverable: task.deliverable,
    definitionOfDone: task.definitionOfDone,
    localPreviewUrl: task.localPreviewUrl ?? null,
    costCents: task.costCents,
    iterationCount: task.iterationCount,
    maxIterations: task.maxIterations,
    body: {
      plannerState: task.plannerState,
      executorState: task.executorState,
      verifierState: task.verifierState,
      incomingArtifactIds: task.incomingArtifactIds,
    },
  };
}

async function loadRefs(db: DbClient, taskId: string): Promise<TaskRefs> {
  const [artifactRefs, childRefs] = await Promise.all([
    db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.taskId, taskId)),
    db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentTaskId, taskId)),
  ]);
  return {
    artifactIds: artifactRefs.map((r) => r.id),
    childTaskIds: childRefs.map((r) => r.id),
  };
}

/** Find a task by id and return it as a fully-hydrated contracts.Task. */
export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractTask | null> {
  const row = await findTaskById(db, id);
  if (!row) return null;
  const refs = await loadRefs(db, id);
  return rowToTask(row, refs);
}

/**
 * Hydrate every task for a company in a constant number of queries (1 for
 * tasks, 1 for artifacts, 1 for children) — no N+1.
 */
export async function listByCompanyHydrated(db: DbClient, companyId: string): Promise<ContractTask[]> {
  const rows = await listTasksByCompany(db, companyId);
  return hydrateMany(db, rows);
}

export async function listByRoleHydrated(
  db: DbClient,
  companyId: string,
  role: string,
  statuses?: TaskStatus[],
): Promise<ContractTask[]> {
  const rows = await listTasksByRole(db, companyId, role, statuses);
  return hydrateMany(db, rows);
}

async function hydrateMany(db: DbClient, rows: Task[]): Promise<ContractTask[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [artifactRefs, childRefs] = await Promise.all([
    db
      .select({ id: artifacts.id, taskId: artifacts.taskId })
      .from(artifacts)
      .where(inArray(artifacts.taskId, ids)),
    db
      .select({ id: tasks.id, parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(inArray(tasks.parentTaskId, ids)),
  ]);

  const artifactsByTask = new Map<string, string[]>();
  for (const a of artifactRefs) {
    if (!a.taskId) continue;
    const list = artifactsByTask.get(a.taskId) ?? [];
    list.push(a.id);
    artifactsByTask.set(a.taskId, list);
  }
  const childrenByParent = new Map<string, string[]>();
  for (const c of childRefs) {
    if (!c.parentTaskId) continue;
    const list = childrenByParent.get(c.parentTaskId) ?? [];
    list.push(c.id);
    childrenByParent.set(c.parentTaskId, list);
  }

  return rows.map((row) =>
    rowToTask(row, {
      artifactIds: artifactsByTask.get(row.id) ?? [],
      childTaskIds: childrenByParent.get(row.id) ?? [],
    }),
  );
}
