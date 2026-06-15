/**
 * Tests for the browser flow-test → CEO suggestion routing (2026-06-15).
 *
 * Goal: the browser agent's findings must reach the CEO as a SUGGESTION for a
 * FUTURE sprint, never get jammed into the just-completed ("this") sprint as a
 * developer bug_fix. The CEO's between-sprints retrospective only surfaces tasks
 * with `kind: "follow_up"` AND `status: "created"` (see ceo.ts
 * buildSprintRetrospectiveContext), and the suggestion must NOT carry the
 * current sprint's id (createWorkflowTask otherwise falls back to it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompanySnapshot } from "@arceus/contracts";
import { buildFlowTestSuggestionTask, verdictFailed } from "./flow-test.js";

function snapshotWithActiveSprint(currentSprintId: string | null): CompanySnapshot {
  return {
    company: { id: "company_x", currentSprintId },
    agents: [{ id: "agent_dev", role: "developer" }],
    tasks: [],
    sprints: [],
  } as unknown as CompanySnapshot;
}

test("suggestion is a follow_up with status 'created' (so the CEO's retrospective surfaces it)", () => {
  const task = buildFlowTestSuggestionTask(snapshotWithActiveSprint("sprint_active"), 2, "VERDICT: FAIL\nISSUES: 1. dead button");
  assert.equal(task.kind, "follow_up", "must be a follow_up suggestion, not bug_fix");
  assert.equal(task.status, "created", "must be 'created' or the CEO retrospective filter skips it");
});

test("suggestion is NOT attached to the current sprint (proposed in a FUTURE sprint, not this one)", () => {
  // currentSprintId is SET — the just-completed sprint. The suggestion must
  // still be backlog (sprintId null), or it lands in 'this' sprint.
  const task = buildFlowTestSuggestionTask(snapshotWithActiveSprint("sprint_just_completed"), 2, "VERDICT: FAIL");
  assert.equal(task.sprintId, null, "suggestion must be backlog, never the current/just-completed sprint");
});

test("suggestion carries the browser verdict in its description for the CEO to read", () => {
  const verdict = "VERDICT: FAIL\nISSUES: 1. delete does not persist\nDESIGN: basic";
  const task = buildFlowTestSuggestionTask(snapshotWithActiveSprint(null), 3, verdict);
  assert.ok(task.description.includes("delete does not persist"), "verdict issues must be in the description");
});

test("verdictFailed: PASS verdict with no issues is not a failure", () => {
  assert.equal(verdictFailed({ verdict: "VERDICT: PASS\nISSUES: none\nDESIGN: god-tier" }), false);
});

test("verdictFailed: explicit FAIL, basic design, or real issues all count as findings", () => {
  assert.equal(verdictFailed({ verdict: "VERDICT: FAIL" }), true);
  assert.equal(verdictFailed({ verdict: "DESIGN: basic" }), true);
  assert.equal(verdictFailed({ verdict: "ISSUES: 1. dead control" }), true);
  assert.equal(verdictFailed({ is_successful: false }), true);
});
