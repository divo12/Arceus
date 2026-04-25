/**
 * scoreBeatVerdict — heuristic for beat outcome (v2).
 *
 * Rather than rely on a separate transition-recorder pipeline (which never
 * got wired up — see git blame for v1), we introspect the Spec 32 event
 * bus directly. Every tool call, task transition, artifact creation, and
 * sprint creation that happened during the beat is already tagged with
 * `beatId` in the ring buffer.
 *
 * Verdict rules (first match wins):
 *   1. error event for this beat                         → fail
 *   2. tool.invoked count == 0                           → fail (zero work)
 *   3. tool.result with `ok: false` and no productive
 *      output afterwards                                  → fail
 *   4. any productive output                              → pass
 *        - artifact.created
 *        - sprint.created
 *        - task.updated containing "status"
 *        - tool.result ok for a mutating tool
 *   5. otherwise (only read-only tool calls)              → fail
 *
 * Productive tools are the ones that mutate company state. Read-only
 * lookups (`get_*`, `list_*`, `company_get_summary`, etc.) and beat
 * housekeeping (`post_watchdog_reset`) don't count as work on their own.
 */
import { snapshot } from "../observability/event-bus.js";

// ── Per-beat task transition tracking (legacy; kept for callers) ─

const beatTaskTransitions = new Map<string, Map<string, string>>();

/** Record a task status change that happened during a beat. */
export function recordBeatTaskTransition(
  beatId: string,
  taskId: string,
  toStatus: string,
): void {
  let tasks = beatTaskTransitions.get(beatId);
  if (!tasks) {
    tasks = new Map();
    beatTaskTransitions.set(beatId, tasks);
  }
  tasks.set(taskId, toStatus); // latest status wins
}

/** Clear tracked transitions for a beat (cleanup). */
export function clearBeatTaskTransitions(beatId: string): void {
  beatTaskTransitions.delete(beatId);
}

// ── Scoring ──────────────────────────────────────────────

/**
 * Tools whose successful invocation by itself proves the beat did real
 * work. Anything not in this list is treated as read-only/housekeeping
 * and won't flip the verdict to pass on its own.
 */
const PRODUCTIVE_TOOLS = new Set<string>([
  "task_claim",
  "task_complete",
  "task_block",
  "task_append_result",
  "task_append_plan_step",
  "patch_progress",
  "artifact_create",
  "post_create",          // sprint_create / message_post lives here
  "sprint_create",
  "memory_write",
  "approval_request",
  "approval_resolve",
  "handoff",
  "meeting_record",
]);

/**
 * Causes that mean "nothing for me to do right now" rather than a real
 * failure. A beat whose only outcome is one of these on `task_claim` is
 * an idle poll — correct behavior, not a fault.
 *
 * NOTE: `not_found` is intentionally NOT here — if the agent claims a task
 * id that doesn't exist, that's a hallucinated id, which IS a real failure.
 */
const BENIGN_CLAIM_CAUSES = new Set<string>([
  "deps_unmet",
  "task_not_claimable",
  "already_claimed",
]);

export async function scoreBeatVerdict(beatId: string): Promise<"pass" | "fail"> {
  const events = snapshot({ beatId, limit: 5000 });

  let toolInvoked = 0;
  let productiveOk = false;
  let hadError = false;
  let realFailure = false;
  let benignIdlePoll = false;
  let claimedOk = false;
  let completedOrBlocked = false;

  for (const ev of events) {
    switch (ev.event) {
      case "error":
        hadError = true;
        break;
      case "tool.invoked":
        toolInvoked++;
        break;
      case "tool.result":
        if (ev.ok && PRODUCTIVE_TOOLS.has(ev.tool)) {
          productiveOk = true;
          if (ev.tool === "task_claim") claimedOk = true;
          if (ev.tool === "task_complete" || ev.tool === "task_block") {
            completedOrBlocked = true;
          }
        } else if (!ev.ok) {
          if (ev.tool === "task_claim" && ev.cause && BENIGN_CLAIM_CAUSES.has(ev.cause)) {
            benignIdlePoll = true;
          } else {
            realFailure = true;
          }
        }
        break;
      case "artifact.created":
      case "sprint.created":
      case "task.updated":
      case "task.created":
      case "task.artifact_attached":
      case "approval.requested":
      case "approval.resolved":
      case "memory.written":
      case "meeting.recorded":
      case "meeting.contribution":
      case "role.handoff":
        productiveOk = true;
        break;
    }
  }

  if (hadError) return "fail";
  if (realFailure && !productiveOk) return "fail";
  // Claimed a task but never completed/blocked it — the task stays open and
  // downstream roles stall. This is the "create artifact, walk away" pattern.
  if (claimedOk && !completedOrBlocked) return "fail";
  if (productiveOk) return "pass";
  // Polled and found nothing to claim → idle pass, not a failure.
  if (benignIdlePoll) return "pass";
  if (toolInvoked === 0) return "fail";
  return "fail";
}

