/**
 * Task `heartbeat` contract field — the per-task living checklist persisted in
 * the task body. Defaults to an empty checklist so existing task constructors
 * don't have to supply it, and round-trips a provided value through the schema.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskSchema } from "./tasks.js";

function baseTaskInput(): Record<string, unknown> {
  return {
    id: "tsk_1",
    companyId: "co_1",
    kind: "technical_plan",
    title: "Build the thing",
    description: "",
    problemStatement: "",
    deliverable: "",
    definitionOfDone: [],
    status: "planned",
    priority: "medium",
    assignedRole: "developer",
    assignedAgentId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0,
  };
}

test("taskSchema defaults heartbeat to an empty checklist", () => {
  const t = taskSchema.parse(baseTaskInput());
  assert.deepEqual(t.heartbeat, { done: [], doing: null, next: [], blocked: null, updatedAt: null });
});

test("taskSchema preserves a provided heartbeat", () => {
  const t = taskSchema.parse({
    ...baseTaskInput(),
    heartbeat: { done: ["wired route"], doing: "writing tests", next: ["deploy"], blocked: null, updatedAt: "2026-06-16T12:00:00.000Z" },
  });
  assert.equal(t.heartbeat.doing, "writing tests");
  assert.deepEqual(t.heartbeat.done, ["wired route"]);
  assert.deepEqual(t.heartbeat.next, ["deploy"]);
});
