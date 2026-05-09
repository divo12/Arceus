/**
 * Company reset — Spec 31 Phase 7.C.c-bis.
 *
 * Atomic teardown of a company's persisted state. The previous
 * `DELETE /api/company` route fanned three separate DB deletes
 * (company_states, policy_violations, trust_scores) outside any
 * transaction, plus a per-row delete in `agents` derived from the
 * snapshot. A failure in the middle could leave the company partially
 * deleted — agents gone but governance rows still pointing at them.
 *
 * This module wraps the canonical-side cascade in one transaction so
 * teardown is atomic. The route handler still does filesystem cleanup
 * (workspace archive) and in-memory state reset outside the
 * transaction — those aren't database operations.
 */
import { getDb, isDatabaseConfigured, trustScoresTable, policyViolations as policyViolationsCanonical, heartbeatRuns } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { inArray, eq } from "drizzle-orm";

interface ResetCompanyResult {
  agentIdsRemoved: string[];
  policyViolationsCleared: number;
  trustScoresCleared: number;
}

/**
 * Atomically clear a company's governance and trust-score rows.
 * The companies cascade is FK-driven (sprints, tasks, meetings,
 * approvals all cascade on `companies.id`). Tables not under the
 * cascade (`policy_violations`, `trust_scores`) are deleted
 * explicitly here so the row count stays consistent.
 *
 * Filesystem and in-memory state cleanup happen outside the
 * transaction — those are the route handler's responsibility.
 */
export async function resetCompanyTx(companyId: string): Promise<ResetCompanyResult> {
  if (!isDatabaseConfigured()) {
    return { agentIdsRemoved: [], policyViolationsCleared: 0, trustScoresCleared: 0 };
  }
  const db = getDb();
  const agents = await agentsRepo.listAgentsByCompany(db, companyId);
  const agentIds = agents.map((a) => a.id);

  let policyViolationsCleared = 0;
  let trustScoresCleared = 0;

  const dbCompanyId = companiesRepo.toDbId(companyId);

  await db.transaction(async (tx) => {
    // Delete heartbeat_runs first (company_id FK, no cascade from reset).
    await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, dbCompanyId));

    // Spec 31 Phase 7.B.5.3 — companyId is now a uuid FK on the
    // canonical `policy_violations` table; map the friendly id.
    const pv = await tx
      .delete(policyViolationsCanonical)
      .where(eq(policyViolationsCanonical.companyId, dbCompanyId))
      .returning({ id: policyViolationsCanonical.id });
    policyViolationsCleared = pv.length;

    if (agentIds.length > 0) {
      const ts = await tx
        .delete(trustScoresTable)
        .where(inArray(trustScoresTable.agentId, agentIds))
        .returning({ id: trustScoresTable.agentId });
      trustScoresCleared = ts.length;
    }
  });

  return { agentIdsRemoved: agentIds, policyViolationsCleared, trustScoresCleared };
}

