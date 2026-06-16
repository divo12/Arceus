/**
 * The per-task heartbeat checklist renders into the agent's beat context, so a
 * multi-beat or blocked task resumes from its Done/Doing/Next/Blocked instead of
 * the append-only "Previously on this task" planSteps trail it replaces.
 * renderCompanyState is the role-agnostic per-beat renderer → testable over a
 * fixture (no DB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderOpenTasksForRole } from "./beat-context-builder.js";

type Ctx = Parameters<typeof renderOpenTasksForRole>[0];

function ctxWithTask(heartbeat: unknown, planSteps: string[] = []): Ctx {
  return {
    company: { id: "c1", name: "Acme", status: "active", goal: "Build it", currentSprintId: null },
    agents: [{ id: "a1", role: "developer", displayName: "Dev" }],
    sprints: [],
    tasks: [
      {
        id: "tsk_1",
        title: "Build the API",
        status: "in_progress",
        assignedRole: "developer",
        dependsOnTaskIds: [],
        plannerState: { objective: "", planSteps, selectedTools: [], currentStepIndex: 0 },
        verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
        heartbeat,
      },
    ],
    artifacts: [],
    memorySummaries: [],
    roleMemoryUnits: null,
    roleAgent: { id: "a1", role: "developer", displayName: "Dev" },
    boardMessages: [],
  } as unknown as Ctx;
}

test("renderOpenTasksForRole renders the task heartbeat (Done/Doing/Next/Blocked)", () => {
  const out = renderOpenTasksForRole(ctxWithTask({
    done: ["wrote the schema"],
    doing: "wiring the route",
    next: ["write tests"],
    blocked: "waiting on the API key",
    updatedAt: "2026-06-16T12:00:00.000Z",
  }), "developer");
  assert.match(out, /Done/);
  assert.match(out, /wrote the schema/);
  assert.match(out, /Doing/);
  assert.match(out, /wiring the route/);
  assert.match(out, /Next/);
  assert.match(out, /write tests/);
  assert.match(out, /Blocked/);
  assert.match(out, /waiting on the API key/);
});

test("renderOpenTasksForRole no longer renders the planSteps 'Previously on this task' trail", () => {
  const out = renderOpenTasksForRole(ctxWithTask(
    { done: [], doing: null, next: [], blocked: null, updatedAt: null },
    ["old step 1", "old step 2"],
  ), "developer");
  assert.doesNotMatch(out, /Previously on this task/i);
  assert.doesNotMatch(out, /old step 1/);
});
