/**
 * Approval mutations — Spec 31 Phase 7.C.d / Spec 34 v3 PR 10.
 */
import type { Approval } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as approvalsRepo from "@arceus/db/src/repos/approvals.js";

export async function upsertApproval(approval: Approval): Promise<Approval> {
  await approvalsRepo.upsertApproval(getDb(), approval);
  return approval;
}

/**
 * Read-modify-write for an approval. Audit C8 — atomic.
 * Spec 33 / Audit C1 — row lock prevents lost-update.
 */
export async function updateApproval(
  approvalId: string,
  updater: (approval: Approval) => Approval,
): Promise<Approval | null> {
  return await getDb().transaction(async (tx) => {
    await approvalsRepo.lockForUpdate(tx, approvalId);
    const current = await approvalsRepo.findByIdHydrated(tx, approvalId);
    if (!current) return null;
    const next = updater(current);
    await approvalsRepo.upsertApproval(tx, next);
    return next;
  });
}
