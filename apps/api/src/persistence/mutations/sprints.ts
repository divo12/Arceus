/**
 * Sprint mutations — Spec 31 Phase 7.C.d / Spec 34 v3 PR 10.
 *
 * Canonical-direct write path for sprints.
 */
import type { Sprint } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";

export async function upsertSprint(sprint: Sprint): Promise<Sprint> {
  await sprintsRepo.upsertSprint(getDb(), sprint);
  return sprint;
}

/**
 * Read-modify-write for a sprint. Audit C8 — atomic via `db.transaction`.
 * Spec 33 / Audit C1 — row lock prevents lost-update races on
 * `reviewState` and other multi-step state machines.
 */
export async function updateSprint(
  sprintId: string,
  updater: (sprint: Sprint) => Sprint,
): Promise<Sprint | null> {
  return await getDb().transaction(async (tx) => {
    await sprintsRepo.lockForUpdate(tx, sprintId);
    const current = await sprintsRepo.findByIdHydrated(tx, sprintId);
    if (!current) return null;
    const next = updater(current);
    await sprintsRepo.upsertSprint(tx, next);
    return next;
  });
}
