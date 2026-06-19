/**
 * The CEO is orchestrate-only (read-only, no `task_claim`) — it physically
 * cannot claim/work a task. A planner that assigns an executable task to
 * role=ceo deadlocks the sprint (live 2026-06-19: "Lock v1 Product Semantics"
 * sat on the CEO forever; everything downstream blocked). assignableRole()
 * routes any ceo-assigned task to pm at creation so the bug class is impossible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignableRole, createWorkflowTask } from "./task-helpers.js";
import type { CompanySnapshot } from "@arceus/contracts";

test("assignableRole routes ceo → pm (CEO cannot execute tasks)", () => {
  assert.equal(assignableRole("ceo"), "pm");
});

test("assignableRole leaves every other role unchanged", () => {
  for (const r of ["pm", "cto", "developer", "tester", "ui_designer", "marketing", "skills_lead"] as const) {
    assert.equal(assignableRole(r), r);
  }
});

test("createWorkflowTask never assigns a task to the CEO", () => {
  const snapshot = {
    company: { id: "co_1", currentSprintId: "sprint_1" },
    agents: [],
  } as unknown as CompanySnapshot;

  const task = createWorkflowTask(
    snapshot, "implementation", "ceo",
    "Lock v1 Product Semantics", "desc", "problem", "deliverable",
    ["done"], "high", "created", "sprint_1",
  );
  assert.equal(task.assignedRole, "pm", "a ceo-assigned task must be created as pm");
});
