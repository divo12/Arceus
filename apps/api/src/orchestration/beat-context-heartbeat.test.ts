/**
 * Agent-facing progress tracking moved from the per-task DB heartbeat field
 * to dream/Chorus-style workspace TODO.md (via todo_write). renderOpenTasksForRole
 * must NOT re-surface the old Done/Doing/Next/Blocked block — resume lives in
 * TODO.md injected separately by prepareBeatRender.
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

test("renderOpenTasksForRole no longer renders the DB heartbeat checklist (TODO.md owns resume)", () => {
  const out = renderOpenTasksForRole(ctxWithTask({
    done: ["wrote the schema"],
    doing: "wiring the route",
    next: ["write tests"],
    blocked: "waiting on the API key",
    updatedAt: "2026-06-16T12:00:00.000Z",
  }), "developer");
  assert.match(out, /Build the API/);
  assert.doesNotMatch(out, /Heartbeat \(your running checklist/);
  assert.doesNotMatch(out, /wrote the schema/);
  assert.doesNotMatch(out, /wiring the route/);
});

test("renderOpenTasksForRole no longer renders the planSteps 'Previously on this task' trail", () => {
  const out = renderOpenTasksForRole(ctxWithTask(
    { done: [], doing: null, next: [], blocked: null, updatedAt: null },
    ["old step 1", "old step 2"],
  ), "developer");
  assert.doesNotMatch(out, /Previously on this task/i);
  assert.doesNotMatch(out, /old step 1/);
});
