/**
 * ChecklistConfig — central thresholds for the heartbeat checklist
 * (cluster C17, flaws F-242 + F-250).
 *
 * Replaces inline magic numbers in `heartbeat-checklist.ts` so values can
 * be tuned per environment without touching code, and so unit tests can
 * pass shorter timeouts via the optional partial override.
 *
 * Defaults match the values these constants had inline before extraction
 * (5min escalation, 10min stuck-after-fix, 90% budget unhealthy ratio).
 *
 * Production reads via env vars (see `loadChecklistConfig`); tests can
 * splat any partial override into the merge.
 */

export interface ChecklistConfig {
  /** A pending escalation older than this is overdue (F-242). */
  escalationTimeoutMs: number;
  /** After auto-fix, a still-blocked task older than this is "stuck" (F-242). */
  stuckAfterFixTimeoutMs: number;
  /** Spent / budgeted ratio above which budget is "unhealthy" (F-250). */
  budgetUnhealthyRatio: number;
}

export const DEFAULT_CHECKLIST_CONFIG: Readonly<ChecklistConfig> = {
  escalationTimeoutMs: 5 * 60 * 1000,
  stuckAfterFixTimeoutMs: 10 * 60 * 1000,
  budgetUnhealthyRatio: 0.9,
};

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build a ChecklistConfig from env vars (with `ARCEUS_CHECKLIST_*` prefix),
 * falling back to defaults. The optional `overrides` arg is for tests.
 */
export function loadChecklistConfig(overrides: Partial<ChecklistConfig> = {}): ChecklistConfig {
  const fromEnv: ChecklistConfig = {
    escalationTimeoutMs: readNumberEnv(
      "ARCEUS_CHECKLIST_ESCALATION_TIMEOUT_MS",
      DEFAULT_CHECKLIST_CONFIG.escalationTimeoutMs,
    ),
    stuckAfterFixTimeoutMs: readNumberEnv(
      "ARCEUS_CHECKLIST_STUCK_AFTER_FIX_TIMEOUT_MS",
      DEFAULT_CHECKLIST_CONFIG.stuckAfterFixTimeoutMs,
    ),
    budgetUnhealthyRatio: readNumberEnv(
      "ARCEUS_CHECKLIST_BUDGET_UNHEALTHY_RATIO",
      DEFAULT_CHECKLIST_CONFIG.budgetUnhealthyRatio,
    ),
  };
  return { ...fromEnv, ...overrides };
}
