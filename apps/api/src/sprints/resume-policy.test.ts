/**
 * Tests for companyHasResumableWork — the boot-time predicate that decides
 * whether the heartbeat engine must resume a company's flow after a deploy/
 * restart.
 *
 * Reliability contract (2026-06-14): a deploy must NEVER strand in-flight work.
 * The previous boot check only resumed `executing`/`reviewing` sprints, so a
 * redeploy that landed while a company was mid-`planning` or `between_sprints`
 * (sprint chaining — the CEO deciding the next sprint) left the engine stopped
 * and the whole flow frozen until manual intervention. This predicate widens
 * resumption to every non-terminal state, biased toward starting (a spurious
 * start is a cheap idle tick the scheduler skips; a missed start strands work).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { companyHasResumableWork } from "./resume-policy.js";

type Snap = Parameters<typeof companyHasResumableWork>[0];

function snap(over: Partial<Snap> & Partial<{ currentSprintId: string | null }>): Snap {
  return {
    company: { currentSprintId: over.currentSprintId ?? over.company?.currentSprintId ?? null },
    sprints: over.sprints ?? [],
    agents: over.agents ?? [{ id: "a" }],
    tasks: over.tasks ?? [],
  };
}

test("resumes a sprint stuck in PLANNING (the gap that stranded chaining on deploy)", () => {
  assert.equal(
    companyHasResumableWork(snap({
      currentSprintId: "s1",
      sprints: [{ id: "s1", status: "planning" }],
    })),
    true,
  );
});

test("resumes a company BETWEEN_SPRINTS (CEO must chain the next sprint)", () => {
  assert.equal(
    companyHasResumableWork(snap({
      currentSprintId: "s1",
      sprints: [{ id: "s1", status: "between_sprints" }],
    })),
    true,
  );
});

test("resumes EXECUTING and REVIEWING (existing behavior preserved)", () => {
  for (const status of ["executing", "reviewing"] as const) {
    assert.equal(
      companyHasResumableWork(snap({ currentSprintId: "s1", sprints: [{ id: "s1", status }] })),
      true,
      `${status} must resume`,
    );
  }
});

test("resumes when agents exist but there is NO current sprint (CEO must plan sprint 1)", () => {
  assert.equal(
    companyHasResumableWork(snap({ currentSprintId: null, agents: [{ id: "ceo" }] })),
    true,
  );
});

test("resumes when currentSprintId dangles (pointer to a missing sprint → reconcile)", () => {
  assert.equal(
    companyHasResumableWork(snap({ currentSprintId: "gone", sprints: [{ id: "s1", status: "completed" }] })),
    true,
  );
});

test("does NOT resume a bare company with no agents (nothing operable to drive)", () => {
  assert.equal(
    companyHasResumableWork(snap({ currentSprintId: null, agents: [] })),
    false,
  );
});

test("does NOT resume when the sprint is COMPLETED and no tasks are pending (idle)", () => {
  assert.equal(
    companyHasResumableWork(snap({
      currentSprintId: "s1",
      sprints: [{ id: "s1", status: "completed" }],
      tasks: [{ status: "completed" }, { status: "cancelled" }],
    })),
    false,
  );
});

test("DOES resume a completed sprint when an unfinished task remains (follow-up/bug-fix work)", () => {
  assert.equal(
    companyHasResumableWork(snap({
      currentSprintId: "s1",
      sprints: [{ id: "s1", status: "completed" }],
      tasks: [{ status: "completed" }, { status: "in_progress" }],
    })),
    true,
  );
});

test("does NOT resume a PAUSED sprint with no pending tasks (intentional pause is honored)", () => {
  assert.equal(
    companyHasResumableWork(snap({
      currentSprintId: "s1",
      sprints: [{ id: "s1", status: "paused" }],
      tasks: [{ status: "completed" }],
    })),
    false,
  );
});
