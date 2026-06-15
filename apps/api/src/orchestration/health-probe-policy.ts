/**
 * Recurring-health-probe selection policy (pure).
 *
 * Decides which companies are due for a between-sprints health probe: only those
 * with a ready live preview that haven't been probed within the interval. The
 * scheduler resolves preview state + lastProbedAt and fires runFlowTestAndReport
 * for the returned ids — so findings flow to the CEO as next-sprint suggestions
 * (same routing as the sprint-finalize probe).
 *
 * Kept pure so the cadence logic is testable without a scheduler/clock/DB.
 */

export interface ProbeCandidate {
  companyId: string;
  /** The product's preview is live + reachable (worth driving). */
  hasReadyPreview: boolean;
  /** Epoch ms of the last probe, or null if never probed. */
  lastProbedAt: number | null;
}

/** Company ids due for a probe now: ready preview + interval elapsed. */
export function selectCompaniesDueForProbe(
  candidates: readonly ProbeCandidate[],
  now: number,
  intervalMs: number,
): string[] {
  return candidates
    .filter((c) => c.hasReadyPreview)
    .filter((c) => c.lastProbedAt === null || now - c.lastProbedAt >= intervalMs)
    .map((c) => c.companyId);
}
