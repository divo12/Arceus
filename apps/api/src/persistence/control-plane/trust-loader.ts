/**
 * Control plane — trust scores + policy violations.
 * Spec 11 / Spec 13 / Spec 31 Phase 7.B.5.3 / Spec 34 v3 PR 11.
 *
 * Owns:
 *   - trustScoreCache  in-memory map keyed by agentId
 *   - recentViolationsCache in-memory ring (cap 500) used as a fallback
 *     when the canonical `policy_violations` query fails
 *   - trustScoresTableMissing flag for the legacy 42P01 path (the
 *     legacy text-PK trust_scores table is being dropped; until
 *     migration 0020 lands the cache becomes authoritative on hosts
 *     that haven't applied it)
 *
 * `getCachedTrustScore` is the cross-file helper `./snapshot.ts`
 * uses inside cpLoadAgentContext; everything else is exported as a
 * public cp* API and re-exported through the barrel.
 */
import { eq, desc } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@arceus/db";
import { trustScoresTable, policyViolations as policyViolationsCanonical } from "@arceus/db";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { adjustTrust, createInitialTrust, getTrustTier, TRUST_CONFIG } from "@arceus/company-runtime";
import type { PolicyViolation, TrustEvent, TrustScore } from "@arceus/contracts";
import { emitEmployeeActivity } from "../../observability/activity.js";

const trustScoreCache = new Map<string, TrustScore>();
const recentViolationsCache: PolicyViolation[] = [];

/**
 * Set to true on first 42P01 (`relation "trust_scores" does not exist`).
 * Subsequent calls bypass the DB silently — the in-memory cache becomes the
 * source of truth until migration 0020 is applied.
 */
let trustScoresTableMissing = false;

function noteTrustTableMissing(scope: string, err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "42P01" || /relation .*trust_scores.* does not exist/i.test(msg)) {
    if (!trustScoresTableMissing) {
      trustScoresTableMissing = true;
      console.warn(`[Governance] trust_scores table missing — running with in-memory cache only (apply migration 0020). First seen during ${scope}.`);
    }
    return true;
  }
  return false;
}

/** Internal helper — read a cached trust score for cpLoadAgentContext. */
export function getCachedTrustScore(agentId: string): number {
  return trustScoreCache.get(agentId)?.score ?? TRUST_CONFIG.initialScore;
}

/** Load trust score from cache or DB. Returns initial score if not found. */
export async function cpLoadTrustScore(agentId: string): Promise<TrustScore> {
  if (trustScoreCache.has(agentId)) {
    return trustScoreCache.get(agentId)!;
  }

  if (isDatabaseConfigured() && !trustScoresTableMissing) {
    try {
      const db = getDb();
      const rows = await db.select().from(trustScoresTable).where(eq(trustScoresTable.agentId, agentId)).limit(1);
      if (rows.length > 0) {
        const row = rows[0];
        const ts: TrustScore = {
          agentId: row.agentId,
          score: row.score,
          history: (row.history as TrustScore["history"]) ?? [],
          updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString(),
        };
        trustScoreCache.set(agentId, ts);
        return ts;
      }
    } catch (err) {
      if (!noteTrustTableMissing(`load(${agentId})`, err)) {
        console.warn(`[Governance] Failed to load trust score for ${agentId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  const initial = createInitialTrust(agentId, new Date().toISOString());
  trustScoreCache.set(agentId, initial);
  return initial;
}

/** Update trust score: apply event, persist to cache + DB. */
export async function cpUpdateTrustScore(event: TrustEvent): Promise<TrustScore> {
  const current = await cpLoadTrustScore(event.agentId);
  const updated = adjustTrust(current, event);
  trustScoreCache.set(event.agentId, updated);

  emitEmployeeActivity("system", "decision", `Trust updated for ${event.agentId}: ${current.score.toFixed(3)} → ${updated.score.toFixed(3)} (${event.kind}: ${event.reason})`, {
    detail: {
      agentId: event.agentId,
      previousScore: current.score,
      newScore: updated.score,
      delta: updated.score - current.score,
      kind: event.kind,
      tier: getTrustTier(updated.score),
    },
  });

  if (isDatabaseConfigured() && !trustScoresTableMissing) {
    try {
      const db = getDb();
      // The legacy trust_scores table in tables.ts declares `history` as a
      // bare `jsonb` without a `$type<TrustEvent[]>()` annotation, so drizzle
      // infers it as `unknown`. The contract-typed `updated.history` is
      // structurally identical; cast through `unknown` to satisfy drizzle
      // without losing type-safety on the rest of the values object.
      const trustHistory = updated.history as unknown as Record<string, unknown>;
      await db.insert(trustScoresTable).values({
        agentId: updated.agentId,
        score: updated.score,
        history: trustHistory,
        updatedAt: new Date(updated.updatedAt),
      }).onConflictDoUpdate({
        target: trustScoresTable.agentId,
        set: {
          score: updated.score,
          history: trustHistory,
          updatedAt: new Date(updated.updatedAt),
        },
      });
    } catch (err) {
      if (!noteTrustTableMissing(`persist(${event.agentId})`, err)) {
        console.warn(`[Governance] Failed to persist trust score for ${event.agentId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return updated;
}

/** Record a policy violation to cache + canonical DB. */
export async function cpRecordPolicyViolation(violation: PolicyViolation): Promise<void> {
  recentViolationsCache.push(violation);
  if (recentViolationsCache.length > 500) recentViolationsCache.splice(0, recentViolationsCache.length - 500);

  emitEmployeeActivity("system", "decision", `Policy violation recorded: agent=${violation.agentId} tool=${violation.tool} rule=${violation.ruleId} severity=${violation.severity}`, {
    detail: {
      violationId: violation.id,
      agentId: violation.agentId,
      tool: violation.tool,
      ruleId: violation.ruleId,
      decision: violation.decision,
      severity: violation.severity,
      detail: violation.detail,
    },
  });

  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      await db.insert(policyViolationsCanonical).values({
        id: friendlyToUuid(violation.id),
        companyId: companiesRepo.toDbId(violation.companyId),
        agentId: violation.agentId ? agentsRepo.toDbId(violation.agentId) : null,
        ruleId: violation.ruleId,
        tool: violation.tool,
        decision: violation.decision,
        severity: violation.severity,
        detail: violation.detail,
        beatId: violation.beatId ? friendlyToUuid(violation.beatId) : null,
        resolvedAt: violation.resolvedAt ? new Date(violation.resolvedAt) : null,
        createdAt: new Date(violation.createdAt),
      });
    } catch (err) {
      console.warn(`[Governance] Failed to persist policy violation:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Get recent policy violations (from canonical DB or in-memory cache fallback). */
export async function cpGetPolicyViolations(opts?: { agentId?: string; limit?: number }): Promise<PolicyViolation[]> {
  const limit = opts?.limit ?? 50;

  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      const conditions = opts?.agentId
        ? eq(policyViolationsCanonical.agentId, agentsRepo.toDbId(opts.agentId))
        : undefined;
      const rows = await db.select().from(policyViolationsCanonical)
        .where(conditions)
        .orderBy(desc(policyViolationsCanonical.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        agentId: r.agentId,
        ruleId: r.ruleId,
        tool: r.tool,
        decision: r.decision as PolicyViolation["decision"],
        severity: r.severity as PolicyViolation["severity"],
        detail: r.detail,
        beatId: r.beatId,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (err) {
      console.warn(`[Governance] Failed to load violations from DB:`, err instanceof Error ? err.message : err);
    }
  }

  let results = [...recentViolationsCache];
  if (opts?.agentId) results = results.filter((v) => v.agentId === opts.agentId);
  return results.slice(-limit).reverse();
}

/** Get all cached trust scores. */
export function cpGetAllTrustScores(): TrustScore[] {
  return Array.from(trustScoreCache.values());
}

/** Load all trust scores from DB into cache. Called at startup. */
export async function cpHydrateTrustScores(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    const db = getDb();
    const rows = await db.select().from(trustScoresTable);
    for (const row of rows) {
      trustScoreCache.set(row.agentId, {
        agentId: row.agentId,
        score: row.score,
        history: (row.history as TrustScore["history"]) ?? [],
        updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString(),
      });
    }
    emitEmployeeActivity("system", "info", `Governance: hydrated ${rows.length} trust scores from DB`);
  } catch (err) {
    if (!noteTrustTableMissing("hydrate", err)) {
      console.warn(`[Governance] Failed to hydrate trust scores:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Initialize trust scores for a freshly hired roster of agents.
 * Spec 31 Phase 7.C.d-cp — replaces the old `storeEvents.on("agents-hired", …)`
 * listener that fired from `store.applyStrategy`. Now called explicitly
 * by `applyStrategyTx` after the transaction commits. Fire-and-forget;
 * failures are warned but never thrown.
 */
export async function cpInitializeAgentTrust(agents: { id: string }[]): Promise<void> {
  const nowIso = new Date().toISOString();
  const results = await Promise.allSettled(
    agents.map((a) =>
      cpUpdateTrustScore({
        agentId: a.id,
        kind: "manual_adjustment",
        delta: 0,
        reason: "Agent hired — initial trust",
        timestamp: nowIso,
      }),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    console.warn(`[Trust] init failed for ${failed}/${agents.length} agents`);
  }
}
