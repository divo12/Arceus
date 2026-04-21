/**
 * scoreBeatVerdict — v1 heuristic for beat outcome.
 *
 * Tracks task status changes recorded during a beat and derives pass/fail.
 * Richer logic (artifact quality, test pass rate, preview-probe) in Phase 7+.
 *
 * Phase 6.5 — Package K.
 */

// ── Per-beat task transition tracking ────────────────────

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

function queryTaskTransitions(beatId: string, toStatus: string): number {
  const tasks = beatTaskTransitions.get(beatId);
  if (!tasks) return 0;
  let count = 0;
  for (const status of tasks.values()) {
    if (status === toStatus) count++;
  }
  return count;
}

export async function scoreBeatVerdict(beatId: string): Promise<"pass" | "fail"> {
  const completed = queryTaskTransitions(beatId, "completed");
  const blocked = queryTaskTransitions(beatId, "blocked");

  if (blocked > 0) return "fail";
  if (completed > 0) return "pass";
  return "fail"; // no completion signal → failed beat
}
