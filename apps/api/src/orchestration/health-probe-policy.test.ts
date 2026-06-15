/**
 * Tests for the recurring-health-probe selection policy.
 *
 * Idea from the Polsia teardown: don't only QA the product at sprint finalize —
 * periodically drive the LIVE product so regressions BETWEEN sprints get caught
 * and routed to the CEO as next-sprint suggestions (reusing runFlowTestAndReport).
 * This pure policy decides WHICH companies are due: only those with a ready
 * preview, not probed within the interval. Pure → testable; the scheduler that
 * resolves preview state + fires the probe wraps it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCompaniesDueForProbe, type ProbeCandidate } from "./health-probe-policy.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

function cand(over: Partial<ProbeCandidate> & { companyId: string }): ProbeCandidate {
  return { hasReadyPreview: true, lastProbedAt: null, ...over };
}

test("a company with a ready preview never probed before is due", () => {
  const due = selectCompaniesDueForProbe([cand({ companyId: "c1" })], NOW, 6 * HOUR);
  assert.deepEqual(due, ["c1"]);
});

test("a company without a ready preview is NEVER due", () => {
  const due = selectCompaniesDueForProbe([cand({ companyId: "c1", hasReadyPreview: false })], NOW, 6 * HOUR);
  assert.deepEqual(due, []);
});

test("a company probed within the interval is not due; one past it is", () => {
  const due = selectCompaniesDueForProbe(
    [
      cand({ companyId: "recent", lastProbedAt: NOW - 1 * HOUR }),
      cand({ companyId: "stale", lastProbedAt: NOW - 7 * HOUR }),
    ],
    NOW,
    6 * HOUR,
  );
  assert.deepEqual(due, ["stale"]);
});

test("a company probed exactly at the interval boundary is due", () => {
  const due = selectCompaniesDueForProbe([cand({ companyId: "c1", lastProbedAt: NOW - 6 * HOUR })], NOW, 6 * HOUR);
  assert.deepEqual(due, ["c1"]);
});

test("selects multiple due companies, preserving order", () => {
  const due = selectCompaniesDueForProbe(
    [
      cand({ companyId: "a" }),
      cand({ companyId: "b", hasReadyPreview: false }),
      cand({ companyId: "c", lastProbedAt: NOW - 10 * HOUR }),
    ],
    NOW,
    6 * HOUR,
  );
  assert.deepEqual(due, ["a", "c"]);
});
