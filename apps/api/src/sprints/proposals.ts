import type { AgentIdentity, Sprint, Task } from "@arceus/contracts";
import { createWorkflowTask, nowIso } from "@arceus/task-engine";
import { createSprintRecord } from "@arceus/task-engine";
import {
  getSnapshot,
  upsertTask,
  updateTask,
  updateSprint,
  upsertSprint,
  updateCompanySprint,
} from "../persistence/store.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphSprintStarted } from "../observability/graph-emitter.js";
import { emitReactiveBroadcast } from "../orchestration/reactive.js";
import { workspaceManager } from "../workspace/manager.js";
import {
  setExecutionStatus,
  eventBridgeStarted,
  setEventBridgeStarted,
  setActiveExecution,
} from "../orchestration/state.js";
import type { SprintCreateInput } from "../routes/internal-mcp/sprints.routes.js";

/**
 * Create a sprint with tasks — called by the sprint_create MCP tool.
 *
 * Pure mechanical work: create records, wire dependencies, activate sprint.
 * All reasoning about WHAT to build comes from the CEO agent.
 */
export async function createSprintWithTasks(input: SprintCreateInput) {
  const snapshot = getSnapshot();

  // Guard: can't start a new sprint while one is active
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  if (currentSprint && !["completed", "cancelled"].includes(currentSprint.status)) {
    throw new Error(`Sprint ${currentSprint.number} is still "${currentSprint.status}". Complete it first.`);
  }

  // Create Sprint N+1
  const sprint = createSprintRecord(
    { upsertSprint, updateCompanySprint, emitReactiveBroadcast: emitReactiveBroadcast as (event: string) => void },
    snapshot,
    `Sprint ${(snapshot.company.currentSprintNumber ?? 0) + 1}: ${input.goal}`,
    input.goal,
  );
  const freshSnapshot = getSnapshot();

  // Create tasks from agent-provided list
  const taskTitleToId = new Map<string, string>();
  const createdTasks: Task[] = [];

  for (const kt of input.tasks) {
    const role = kt.assigned_role as AgentIdentity["role"];
    const task = createWorkflowTask(
      freshSnapshot,
      "implementation",
      role,
      kt.title,
      kt.description || kt.title,
      kt.description || kt.title,
      kt.title,
      [`${kt.title} completed`],
      kt.priority as Task["priority"],
      "created",
      sprint.id,
    );
    taskTitleToId.set(kt.title, task.id);
    createdTasks.push(task);
  }

  // Resolve dependencies by title
  for (const kt of input.tasks) {
    const taskId = taskTitleToId.get(kt.title);
    if (!taskId) continue;
    const depIds = (kt.depends_on || [])
      .map((depTitle: string) => taskTitleToId.get(depTitle))
      .filter((id): id is string => Boolean(id));
    if (depIds.length > 0) {
      const idx = createdTasks.findIndex((t) => t.id === taskId);
      if (idx >= 0) {
        createdTasks[idx] = {
          ...createdTasks[idx],
          dependsOnTaskIds: depIds,
          parentTaskId: depIds[0],
        };
      }
    }
  }

  // Persist all tasks
  for (const task of createdTasks) {
    upsertTask(task);
  }

  // Graph instrumentation
  emitGraphSprintStarted(sprint.id, sprint.number, sprint.goal, createdTasks, "ceo_proposal");

  // Auto-promote tasks with no dependencies to "planned"
  for (const task of createdTasks) {
    if (task.dependsOnTaskIds.length === 0 && task.status === "created") {
      updateTask(task.id, (t) => ({ ...t, status: "planned" as Task["status"] }));
    }
  }

  // Mark sprint as active
  updateSprint(sprint.id, (s) => ({
    ...s,
    status: "executing" as Sprint["status"],
    startedAt: nowIso(),
  }));

  emitEmployeeActivity(
    "system",
    "info",
    `Sprint ${sprint.number} created by CEO with ${createdTasks.length} tasks. Execution starting.`,
  );

  setActiveExecution({
    companyId: freshSnapshot.company.id,
    buildTaskId: "",
    previewTaskId: "",
    reviewTaskId: "",
  });

  await beginSprintExecution();

  return { sprintId: sprint.id, sprintNumber: sprint.number, taskCount: createdTasks.length };
}

/**
 * Sprint execution entry — ensures workspace is ready and sets status.
 */
export async function beginSprintExecution(
  onStartEventBridge?: () => Promise<void>,
): Promise<void> {
  const snapshot = getSnapshot();

  setExecutionStatus("executing");

  try {
    await workspaceManager.ensureLocal(snapshot.company.id);

    if (!eventBridgeStarted && onStartEventBridge) {
      onStartEventBridge().catch(() => {});
      setEventBridgeStarted(true);
    }

    emitEmployeeActivity(
      "system",
      "info",
      "Sprint execution ready — heartbeat engine will pick up planned tasks.",
    );
  } catch (err) {
    setExecutionStatus("error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    emitEmployeeActivity("system", "error", `Sprint execution failed: ${msg}`);
  }
}
