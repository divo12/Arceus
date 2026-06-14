/**
 * Boot-time resume policy — decides whether the heartbeat engine must resume a
 * company's flow after a server restart/redeploy.
 *
 * Reliability invariant: a deploy must never strand in-flight work. The boot
 * sweep (stranded-run-sweeper) reclaims abandoned `running` beats; this policy
 * is the other half — it ensures the engine is actually STARTED whenever any
 * company still has work to drive.
 *
 * Pure + dependency-free so it is cheap to unit-test (see resume-policy.test.ts)
 * and so the boot path can call it per-company without DB coupling.
 *
 * Bias: when uncertain, resume. A spurious start is a cheap idle tick the
 * scheduler's per-role pre-flight skips; a MISSED start freezes the whole flow
 * until manual intervention (observed: a redeploy during `planning` /
 * `between_sprints` left chaining stuck). Asymmetric cost → resume liberally.
 */

/** Sprint statuses that represent active, in-flight work the engine must drive. */
const RESUMABLE_SPRINT_STATUSES: ReadonlySet<string> = new Set([
  "planning",
  "executing",
  "reviewing",
  "between_sprints",
]);

/** Task statuses that count as "done" — anything else is still actionable. */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

export interface ResumePolicyInput {
  company: { currentSprintId: string | null };
  sprints: readonly { id: string; status: string }[];
  agents: readonly unknown[];
  tasks: readonly { status: string }[];
}

/**
 * True when the heartbeat engine should run for this company after a restart.
 *
 * Mirrors the runtime's own notion of "has work" (see
 * `sprintNeedsCeoAttention` in lifecycle.ts) so boot-resume and per-tick
 * waking never disagree.
 */
export function companyHasResumableWork(snapshot: ResumePolicyInput): boolean {
  // A company with no agents isn't operable — there's no role to fire.
  if (snapshot.agents.length === 0) return false;

  // Agents exist but no current sprint → the CEO must plan the first/next
  // sprint. (A bare just-registered company has no agents, so this only fires
  // post strategy-apply when there genuinely is a CEO to wake.)
  const currentSprintId = snapshot.company.currentSprintId;
  if (!currentSprintId) return true;

  const current = snapshot.sprints.find((s) => s.id === currentSprintId);
  // Dangling pointer → let the engine wake the CEO to reconcile rather than
  // silently freezing.
  if (!current) return true;

  // Any non-terminal sprint state is in-flight work.
  if (RESUMABLE_SPRINT_STATUSES.has(current.status)) return true;

  // Sprint is terminal/paused, but unfinished tasks remain (e.g. follow-up or
  // bug-fix work that outlived the sprint) → still actionable.
  return snapshot.tasks.some((t) => !TERMINAL_TASK_STATUSES.has(t.status));
}
