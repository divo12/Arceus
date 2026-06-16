/**
 * Tasks repo — DB row ↔ contracts.Task hydration.
 * Spec 34 v3 PR 6.
 *
 * `tasks.body` jsonb (added in Phase 3A) carries the runtime sub-state that
 * hasn't earned its own table yet — planner/executor/verifier and incoming
 * artifact refs. `artifactIds` and `childTaskIds` are derived from sibling
 * tables, not stored on the row, so the hydration helpers either fetch them
 * per-task (`findByIdHydrated`) or batch-fetch for a list (`listByCompanyHydrated`).
 */
import { and, eq, inArray } from "drizzle-orm";
import type {
  Task as ContractTask,
  RoleType,
  PlannerState,
  ExecutorState,
  VerifierState,
  HeartbeatChecklist,
} from "@arceus/contracts";
import { defaultHeartbeat } from "@arceus/contracts";
import { tasks } from "../../schema/tasks.js";
import { artifacts } from "../../schema/artifacts.js";
import type { DbClient } from "../_helpers.js";
import { fromDbId, toDbId } from "./ids.js";
import type { NewTask, Task, TaskStatus } from "./ids.js";
import { findTaskById, listTasksByCompany } from "./queries.js";

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
  heartbeat?: HeartbeatChecklist;
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

const DEFAULT_HEARTBEAT: HeartbeatChecklist = defaultHeartbeat();

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
    heartbeat: body.heartbeat ?? DEFAULT_HEARTBEAT,
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
      heartbeat: task.heartbeat,
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

/** Internal — only used by `listByRoleHydrated`. */
async function listTasksByRole(
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
