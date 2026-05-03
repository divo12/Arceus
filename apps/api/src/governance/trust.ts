/**
 * Governance trust — read/write the role_trust table.
 *
 * Phase 5 PR #10: replaces the v1 stub in beat-context-builder with a real
 * DB read, and lets run-beat update the rolling pass rate after each beat.
 *
 * Trust band thresholds (kept simple — Phase 7+ may layer in policy
 * matrices, time-decay, or company-level overrides):
 *
 *   probation: rollingPassRate < 0.40
 *   senior   : rollingPassRate > 0.85 AND beatsInBand >= 10
 *   standard : everything else
 *
 * EMA constants live here so the trust controller stays a single, readable
 * file instead of being scattered across the orchestrator.
 */
import type { TrustBand } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as roleTrustRepo from "@arceus/db/src/repos/role_trust.js";
import { toDbId } from "@arceus/db/src/repos/companies.js";
import postgres from "postgres";

const EMA_ALPHA = 0.2;
const PROBATION_THRESHOLD = 0.4;
const SENIOR_THRESHOLD = 0.85;
const SENIOR_MIN_BEATS_IN_BAND = 10;
const DEFAULT_PASS_RATE = 0.5;
const DEFAULT_BAND: TrustBand = "standard";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

function bandFor(rollingPassRate: number, beatsInBand: number): TrustBand {
  if (rollingPassRate < PROBATION_THRESHOLD) return "probation";
  if (rollingPassRate > SENIOR_THRESHOLD && beatsInBand >= SENIOR_MIN_BEATS_IN_BAND) {
    return "senior";
  }
  return "standard";
}

/**
 * Read the current trust band for a (company, role) pair. Returns the
 * default band if no row exists yet — first beat for a freshly hired role.
 */
export async function computeTrustBand(role: string, companyId: string): Promise<TrustBand> {
  try {
    const row = await roleTrustRepo.getTrust(getDb(), toDbId(companyId), role);
    if (!row) return DEFAULT_BAND;
    return row.band as TrustBand;
  } catch (err) {
    console.warn(`[trust] read skipped for ${companyId}/${role} (pg=${pgErrorCode(err)})`);
    return DEFAULT_BAND;
  }
}

/**
 * Update the rolling pass rate after a beat verdict. Upserts the row,
 * recomputes the band, and records a transition event when the band
 * changes. Fire-and-forget — never throws.
 */
export async function updateTrustScore(
  role: string,
  companyId: string,
  verdict: "pass" | "fail",
): Promise<void> {
  const db = getDb();
  const dbCompanyId = toDbId(companyId);
  try {
    const prior = await roleTrustRepo.getTrust(db, dbCompanyId, role);
    const priorBand = (prior?.band as TrustBand | undefined) ?? DEFAULT_BAND;
    const priorRate = prior ? Number(prior.rollingPassRate) : DEFAULT_PASS_RATE;
    const priorBeatsInBand = prior?.beatsInBand ?? 0;

    const verdictScore = verdict === "pass" ? 1 : 0;
    const nextRate = EMA_ALPHA * verdictScore + (1 - EMA_ALPHA) * priorRate;
    const nextBeatsInBand = priorBeatsInBand + 1;
    const nextBand = bandFor(nextRate, nextBeatsInBand);
    const bandChanged = nextBand !== priorBand;

    await roleTrustRepo.upsertTrust(db, {
      companyId: dbCompanyId,
      role,
      band: nextBand,
      rollingPassRate: nextRate.toFixed(3),
      // Reset the in-band counter on a transition so senior promotion
      // requires a sustained streak in the new band.
      beatsInBand: bandChanged ? 0 : nextBeatsInBand,
      lastVerdictAt: new Date(),
    });

    if (bandChanged) {
      await roleTrustRepo.recordTransition(db, {
        companyId: dbCompanyId,
        role,
        fromBand: priorBand,
        toBand: nextBand,
        reason: `verdict ${verdict}, rolling=${nextRate.toFixed(3)}`,
      });
    }
  } catch (err) {
    console.warn(`[trust] update skipped for ${companyId}/${role} (pg=${pgErrorCode(err)})`);
  }
}
