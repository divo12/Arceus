/**
 * SkillsLeadPolicy — thresholds for the Skills Lead branch of the
 * heartbeat checklist executor (cluster C17 — F-281 + F-288).
 *
 * Replaces inline magic numbers in `checklist-executor.ts`. Defaults
 * match the values these constants had before extraction.
 *
 *   underperformerSuccessRate — `getUnderperformingSkills(co, X)` cutoff
 *   unusedSkillStaleDays      — `getUnusedSkills(co, X)` window
 *   patternClusterMinSize     — `analyzeSprintPatterns(co, sprint, X)`
 *   maxBatchPerBeat           — caps how many unused/candidate skills
 *                               a single beat will deprecate / promote
 *
 * Production reads via env (`ARCEUS_SKILLS_LEAD_*`); tests can override
 * via the partial in `loadSkillsLeadPolicy`.
 */

interface SkillsLeadPolicy {
  underperformerSuccessRate: number;
  unusedSkillStaleDays: number;
  patternClusterMinSize: number;
  maxBatchPerBeat: number;
}

const DEFAULT_SKILLS_LEAD_POLICY: Readonly<SkillsLeadPolicy> = {
  underperformerSuccessRate: 0.6,
  unusedSkillStaleDays: 30,
  patternClusterMinSize: 3,
  maxBatchPerBeat: 3,
};

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadSkillsLeadPolicy(overrides: Partial<SkillsLeadPolicy> = {}): SkillsLeadPolicy {
  const fromEnv: SkillsLeadPolicy = {
    underperformerSuccessRate: readNumberEnv(
      "ARCEUS_SKILLS_LEAD_UNDERPERFORMER_RATE",
      DEFAULT_SKILLS_LEAD_POLICY.underperformerSuccessRate,
    ),
    unusedSkillStaleDays: readNumberEnv(
      "ARCEUS_SKILLS_LEAD_UNUSED_DAYS",
      DEFAULT_SKILLS_LEAD_POLICY.unusedSkillStaleDays,
    ),
    patternClusterMinSize: readNumberEnv(
      "ARCEUS_SKILLS_LEAD_CLUSTER_MIN",
      DEFAULT_SKILLS_LEAD_POLICY.patternClusterMinSize,
    ),
    maxBatchPerBeat: readNumberEnv(
      "ARCEUS_SKILLS_LEAD_BATCH_MAX",
      DEFAULT_SKILLS_LEAD_POLICY.maxBatchPerBeat,
    ),
  };
  return { ...fromEnv, ...overrides };
}
