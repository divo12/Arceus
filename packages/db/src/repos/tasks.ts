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
import { friendlyToUuid } from "./_uuid.js";

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStatus = Task["status"];

// ── ID boundary: friendly strings ↔ UUID columns (Phase 3C) ──────
//
// The application layer uses prefixed friendly IDs (`tsk_xxx`, `co_xxx`,
// `beat_xxx`, etc.) but the DB schema columns are uuid. Rather than widen
// every PK + FK column to text (~75 columns across 25 tables), the repo
// converts at its boundary:
//
//   write: friendly  → toDbId() → uuidv5 deterministic uuid → DB column
//   read:  uuid      → restored from body.friendlyIds       → friendly
//
// uuidv5 is deterministic, so a round-trip "tsk_abc" → uuid → "tsk_abc"
// always lands on the same uuid. Looking up by friendly id never needs a
// reverse lookup — we hash the friendly to compute the uuid and query
// directly. Friendly strings are also stashed in `body.friendlyIds` so
// hydration can return them verbatim instead of leaking uuid format
// to API consumers.

/** Map a friendly id (`tsk_abc`) to a deterministic uuid; valid uuids pass through.
 *  Single source of truth lives in `_uuid.ts` — DO NOT change the namespace
 *  after data exists, would invalidate every PK derived from a friendly string. */
export const toDbId = friendlyToUuid;

/** Restore the friendly id from body if it was stashed; otherwise fall back to the uuid. */
export function fromDbId(uuid: string, friendlyHint?: string | null): string {
  return friendlyHint ?? uuid;
}

// ── CRUD ───────────────────────────────────────────────────────

export async function createTask(db: DbClient, data: NewTask): Promise<Task> {
  const [row] = await db.insert(tasks).values(data).returning();
  return row;
}

export async function findTaskById(db: DbClient, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function listTasksByCompany(db: DbClient, companyId: string): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.companyId, toDbId(companyId)));
}

export async function listTasksByRole(
  db: DbClient,
  companyId: string,
  role: string,
  statuses?: TaskStatus[],
): Promise<Task[]> {
  const conditions = [eq(tasks.companyId, toDbId(companyId)), eq(tasks.assignedRole, role)];
  if (statuses && statuses.length > 0) {
    conditions.push(inArray(tasks.status, statuses));
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions));
}

export async function listTasksBySprint(db: DbClient, sprintId: string): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.sprintId, toDbId(sprintId)));
}

/**
 * Spec 31 Phase 7 — list tasks claimed by a specific agent. Used by
 * the heartbeat path that previously did
 * `snapshot.tasks.filter(t => t.assignedAgentId === agentId)`.
 */
export async function listTasksByAgent(
  db: DbClient,
  agentId: string,
  statuses?: TaskStatus[],
): Promise<Task[]> {
  const conditions = [eq(tasks.assignedAgentId, toDbId(agentId))];
  if (statuses && statuses.length > 0) {
    conditions.push(inArray(tasks.status, statuses));
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions));
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

export async function updateTask(
  db: DbClient,
  id: string,
  patch: Partial<NewTask>,
): Promise<Task | null> {
  const [row] = await db.update(tasks).set(patch).where(eq(tasks.id, toDbId(id))).returning();
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
  const claimableStatuses: TaskStatus[] = ["created", "planned", "ready"];
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
    const fid = (r.body as any)?.friendlyIds?.id;
    return typeof fid === "string" ? fid : r.id;
  });
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

export async function appendPlanStep(
  db: DbClient,
  taskId: string,
  step: { stepNumber: number; description: string; status: "pending" | "done" | "skipped"; note?: string },
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ plan: sql`${tasks.plan} || ${JSON.stringify([step])}::jsonb` })
    .where(eq(tasks.id, toDbId(taskId)))
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

interface FriendlyIds {
  id?: string;
  companyId?: string;
  sprintId?: string | null;
  parentTaskId?: string | null;
  assignedAgentId?: string | null;
  dependsOnTaskIds?: string[];
}

interface TaskBody {
  plannerState?: PlannerState;
  executorState?: ExecutorState;
  verifierState?: VerifierState;
  incomingArtifactIds?: string[];
  /** Phase 3C — preserve friendly id strings so hydration round-trips. */
  friendlyIds?: FriendlyIds;
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
 *
 * IDs round-trip via `body.friendlyIds`: when present, the friendly string
 * is restored verbatim. Side-table refs come back as uuids (the artifacts
 * + child tasks tables haven't been bridged yet) — the route layer will
 * convert those when those tables migrate.
 */
export function rowToTask(row: Task, refs: TaskRefs): ContractTask {
  const body = (row.body ?? {}) as TaskBody;
  const friendlies = body.friendlyIds ?? {};
  return {
    id: fromDbId(row.id, friendlies.id),
    companyId: fromDbId(row.companyId, friendlies.companyId),
    sprintId: row.sprintId ? fromDbId(row.sprintId, friendlies.sprintId) : null,
    kind: row.kind as ContractTask["kind"],
    title: row.title,
    description: row.description ?? "",
    problemStatement: row.problemStatement ?? "",
    deliverable: row.deliverable ?? "",
    definitionOfDone: row.definitionOfDone,
    status: row.status as ContractTask["status"],
    priority: row.priority as ContractTask["priority"],
    assignedRole: (row.assignedRole ?? "developer") as RoleType,
    assignedAgentId: row.assignedAgentId
      ? fromDbId(row.assignedAgentId, friendlies.assignedAgentId)
      : null,
    parentTaskId: row.parentTaskId
      ? fromDbId(row.parentTaskId, friendlies.parentTaskId)
      : null,
    dependsOnTaskIds: row.dependsOnTaskIds.map((uuid, i) =>
      fromDbId(uuid, friendlies.dependsOnTaskIds?.[i]),
    ),
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
 * Friendly IDs (`tsk_xxx`, `co_xxx`, etc.) are converted to deterministic
 * uuids for the typed columns and stashed in `body.friendlyIds` so
 * hydration can return them verbatim (see `rowToTask`).
 */
export function taskToInsert(task: ContractTask): NewTask {
  return {
    id: toDbId(task.id),
    companyId: toDbId(task.companyId),
    sprintId: task.sprintId ? toDbId(task.sprintId) : null,
    parentTaskId: task.parentTaskId ? toDbId(task.parentTaskId) : null,
    title: task.title,
    description: task.description,
    kind: task.kind,
    priority: task.priority,
    status: task.status,
    assignedRole: task.assignedRole,
    assignedAgentId: task.assignedAgentId ? toDbId(task.assignedAgentId) : null,
    dependsOnTaskIds: task.dependsOnTaskIds.map(toDbId),
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
      friendlyIds: {
        id: task.id,
        companyId: task.companyId,
        sprintId: task.sprintId,
        parentTaskId: task.parentTaskId,
        assignedAgentId: task.assignedAgentId,
        dependsOnTaskIds: task.dependsOnTaskIds,
      },
    },
  };
}

/**
 * Insert a task or replace it if the row already exists. The dual-write path
 * in `tasks.routes.ts` (Phase 3C) calls this after every mutation to keep
 * the DB in sync with the in-memory snapshot. `id` is preserved on conflict;
 * everything else (status, body, columns) is overwritten with the latest state.
 */
export async function upsertTask(db: DbClient, task: ContractTask): Promise<Task> {
  const { id, ...updateFields } = taskToInsert(task);
  const [row] = await db
    .insert(tasks)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({ target: tasks.id, set: updateFields })
    .returning();
  return row;
}

async function loadRefs(db: DbClient, dbTaskId: string): Promise<TaskRefs> {
  const [artifactRefs, childRefs] = await Promise.all([
    db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.taskId, dbTaskId)),
    db.select({ id: tasks.id, body: tasks.body }).from(tasks).where(eq(tasks.parentTaskId, dbTaskId)),
  ]);
  return {
    artifactIds: artifactRefs.map((r) => r.id),
    childTaskIds: childRefs.map((r) => {
      const friendlies = ((r.body ?? {}) as TaskBody).friendlyIds;
      return fromDbId(r.id, friendlies?.id);
    }),
  };
}

/** Find a task by friendly id and return it as a fully-hydrated contracts.Task. */
export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractTask | null> {
  const dbId = toDbId(id);
  const row = await findTaskById(db, dbId);
  if (!row) return null;
  const refs = await loadRefs(db, dbId);
  return rowToTask(row, refs);
}

/**
 * Hydrate every task for a company in a constant number of queries (1 for
 * tasks, 1 for artifacts, 1 for children) — no N+1.
 */
export async function listByCompanyHydrated(db: DbClient, companyId: string): Promise<ContractTask[]> {
  const rows = await listTasksByCompany(db, toDbId(companyId));
  return hydrateMany(db, rows);
}

export async function listByRoleHydrated(
  db: DbClient,
  companyId: string,
  role: string,
  statuses?: TaskStatus[],
): Promise<ContractTask[]> {
  const rows = await listTasksByRole(db, toDbId(companyId), role, statuses);
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
      .select({ id: tasks.id, parentTaskId: tasks.parentTaskId, body: tasks.body })
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
    const friendlies = ((c.body ?? {}) as TaskBody).friendlyIds;
    list.push(fromDbId(c.id, friendlies?.id));
    childrenByParent.set(c.parentTaskId, list);
  }

  return rows.map((row) =>
    rowToTask(row, {
      artifactIds: artifactsByTask.get(row.id) ?? [],
      childTaskIds: childrenByParent.get(row.id) ?? [],
    }),
  );
}
