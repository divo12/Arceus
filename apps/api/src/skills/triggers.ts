/**
 * Spec 29 Phase G + H — trigger helpers shared by the scheduler tick
 * and the run-beat hook.
 *
 * All helpers are pure DB operations with `(skillId, trigger)` dedup
 * baked in via `maybeEnqueueEvolveJob`. No LLM, no fs, no git.
 */
import { sql, and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  isDatabaseConfigured,
  skillEvolveJobs,
  skillArtifacts,
  skillRevisions,
} from "@arceus/db";
import {
  enqueueJob,
  type SkillEvolveJob,
} from "@arceus/db/src/repos/skill_evolve_jobs.js";

const DEFAULT_BASELINE_EMA = 0.7;
const ACTIVE_STATUSES = ["pending", "claimed", "running"];

export type EvolveTrigger = "ema_drop" | "cron" | "candidate" | "rollback";

/**
 * Insert a job iff there is no active job for this `(skillId, trigger)` pair
 * (active = status in pending/claimed/running). Returns the inserted row or
 * null if dedup'd out. `targetSkillId=null` is allowed for "candidate" and
 * "discovery" jobs and bypasses the dedup check (they're cheap).
 */
export async function maybeEnqueueEvolveJob(args: {
  companyId: string;
  trigger: EvolveTrigger;
  targetSkillId: string | null;
  payload?: Record<string, unknown>;
}): Promise<SkillEvolveJob | null> {
  if (!isDatabaseConfigured()) return null;
  const db = getDb();
  if (args.targetSkillId) {
    const existing = await db
      .select({ id: skillEvolveJobs.id })
      .from(skillEvolveJobs)
      .where(
        and(
          eq(skillEvolveJobs.targetSkillId, args.targetSkillId),
          eq(skillEvolveJobs.trigger, args.trigger),
          inArray(skillEvolveJobs.status, ACTIVE_STATUSES),
        ),
      )
      .limit(1);
    if (existing.length > 0) return null;
  }
  return enqueueJob(db, {
    companyId: args.companyId,
    trigger: args.trigger,
    targetSkillId: args.targetSkillId,
    payload: args.payload ?? {},
  });
}

/**
 * Read the EMA recorded at the most recent revision of `skillId`.
 *
 * Format: revisions written by Phase C MCP routes embed `[ema=N.NN]` at the
 * end of `summary`. Returns null if no revision exists or the marker is
 * missing (caller defaults to 0.7 per spec §G.3).
 */
export async function getRevisionBaselineEma(skillId: string): Promise<number | null> {
  if (!isDatabaseConfigured()) return null;
  const db = getDb();
  const rows = await db
    .select({ summary: skillRevisions.summary })
    .from(skillRevisions)
    .where(eq(skillRevisions.skillId, skillId))
    .orderBy(sql`${skillRevisions.revisionNumber} DESC`)
    .limit(1);
  return parseEmaFromSummary(rows[0]?.summary ?? null);
}

/** Extract the trailing `[ema=N.NN]` marker from a revision summary. */
export function parseEmaFromSummary(summary: string | null): number | null {
  if (!summary) return null;
  const m = /\[ema=([\d.]+)\]/.exec(summary);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Append `[ema=N.NN]` to a summary, capped at 280 chars total. */
export function embedEmaInSummary(summary: string, ema: number): string {
  const tag = ` [ema=${ema.toFixed(2)}]`;
  const max = 280;
  if (summary.length + tag.length <= max) return summary + tag;
  // Truncate the user's portion just enough to make room.
  const room = max - tag.length;
  return summary.slice(0, Math.max(0, room - 1)).trimEnd() + tag;
}

export const EMA_BASELINE_DEFAULT = DEFAULT_BASELINE_EMA;

/**
 * Phase G.2 — nightly cron sweep. Selects active skills with bad outcomes
 * over the last 24h that have NOT been queued in the same window, and
 * enqueues one cron job per skill (per company).
 *
 * `minInvocations` and `maxPassRate` mirror the spec defaults (≥20 invocations,
 * ≤0.7 average outcome score over 24h).
 */
export async function runCronTriggerSweep(opts: {
  minInvocations?: number;
  maxPassRate?: number;
} = {}): Promise<{ enqueued: number; skipped: number }> {
  if (!isDatabaseConfigured()) return { enqueued: 0, skipped: 0 };
  const db = getDb();
  const minInv = opts.minInvocations ?? 20;
  const maxRate = opts.maxPassRate ?? 0.7;

  const rows = (await db.execute(sql`
    SELECT sa.id AS skill_id, sa.company_id AS company_id
      FROM skill_artifacts sa
     WHERE sa.status = 'active'
       AND sa.id NOT IN (
         SELECT target_skill_id FROM skill_evolve_jobs
          WHERE created_at > now() - interval '24 hours'
            AND target_skill_id IS NOT NULL
       )
       AND sa.id IN (
         SELECT skill_id FROM skill_usage_events
          WHERE occurred_at > now() - interval '24 hours'
          GROUP BY skill_id
         HAVING count(*) >= ${minInv}
            AND avg(outcome_score) <= ${maxRate}
       )
  `)) as unknown as Array<{ skill_id: string; company_id: string }>;

  let enqueued = 0;
  let skipped = 0;
  for (const r of rows) {
    const job = await maybeEnqueueEvolveJob({
      companyId: r.company_id,
      trigger: "cron",
      targetSkillId: r.skill_id,
      payload: { window: "24h" },
    });
    if (job) enqueued++; else skipped++;
  }
  return { enqueued, skipped };
}

/**
 * Phase H.1 — rollback monitor. For each skill that received a non-rollback
 * revision in the last 24h, compares post-apply EMA against the pre-apply
 * baseline. Enqueues a rollback job when EMA dropped > 0.10 with ≥20
 * invocations since apply. Honours `(skillId,'rollback')` dedup and the
 * 7-day flap-protection cap.
 */
export async function runRollbackMonitor(opts: {
  minInvocations?: number;
  maxFlapsPer7d?: number;
} = {}): Promise<{ proposed: number; skipped: number; protected: number }> {
  if (!isDatabaseConfigured()) return { proposed: 0, skipped: 0, protected: 0 };
  const db = getDb();
  const minInv = opts.minInvocations ?? 20;
  const flapCap = opts.maxFlapsPer7d ?? 1;

  const recent = (await db.execute(sql`
    SELECT skill_id,
           MAX(revision_number) AS rev,
           MAX(created_at)      AS applied_at
      FROM skill_revisions
     WHERE created_at > now() - interval '24 hours'
       AND rollback_from_tag IS NULL
     GROUP BY skill_id
  `)) as unknown as Array<{ skill_id: string; rev: number; applied_at: Date | string }>;

  let proposed = 0;
  let skipped = 0;
  let protectedCount = 0;
  for (const r of recent) {
    // 0. Flap protection — count rollbacks in the last 7d.
    const flaps = (await db.execute(sql`
      SELECT count(*)::int AS n FROM skill_revisions
       WHERE skill_id = ${r.skill_id}
         AND rollback_from_tag IS NOT NULL
         AND created_at > now() - interval '7 days'
    `)) as unknown as Array<{ n: number }>;
    if ((flaps[0]?.n ?? 0) > flapCap) {
      protectedCount++;
      continue;
    }

    const appliedAtIso = r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at);

    // 1. Invocations since apply.
    const inv = (await db.execute(sql`
      SELECT count(*)::int AS n FROM skill_usage_events
       WHERE skill_id = ${r.skill_id}
         AND occurred_at > ${appliedAtIso}::timestamptz
    `)) as unknown as Array<{ n: number }>;
    if ((inv[0]?.n ?? 0) < minInv) { skipped++; continue; }

    // 2. Current EMA = registry successRate (column on skill_artifacts).
    const sa = await db
      .select({ id: skillArtifacts.id, successRate: skillArtifacts.successRate, companyId: skillArtifacts.companyId })
      .from(skillArtifacts)
      .where(eq(skillArtifacts.id, r.skill_id))
      .limit(1);
    const skill = sa[0];
    if (!skill) { skipped++; continue; }
    const currentEma = Number(skill.successRate);

    // 3. Prior revision summary → baseline ema.
    const prior = await db
      .select({ summary: skillRevisions.summary, gitTag: skillRevisions.gitTag })
      .from(skillRevisions)
      .where(eq(skillRevisions.skillId, r.skill_id))
      .orderBy(sql`${skillRevisions.revisionNumber} DESC`)
      .limit(2);
    // prior[0] is the just-applied revision; prior[1] is the baseline.
    const baselineSummary = prior[1]?.summary ?? null;
    const fromTag = prior[1]?.gitTag ?? null;
    const baselineEma = parseEmaFromSummary(baselineSummary) ?? DEFAULT_BASELINE_EMA;

    if (currentEma >= baselineEma - 0.10 || !fromTag) { skipped++; continue; }

    const job = await maybeEnqueueEvolveJob({
      companyId: skill.companyId,
      trigger: "rollback",
      targetSkillId: r.skill_id,
      payload: { fromTag, applied_at: appliedAtIso, baselineEma, currentEma },
    });
    if (job) proposed++; else skipped++;
  }
  return { proposed, skipped, protected: protectedCount };
}
