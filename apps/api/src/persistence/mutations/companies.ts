/**
 * Company / chat / lifecycle mutations — Spec 31 Phase 7.C.d / Spec 34 v3 PR 10.
 *
 * Includes the company-level pointer updates (`updateCompanySprint`,
 * `updateCompanyStatus`), the board chat append (chat is per-company
 * scoped), and the post-7.C.d lifecycle no-ops still wired into
 * route handlers (`resetCompany`, `clearPersistedStoreState`,
 * `getEvents`). The no-ops survive only so route signatures don't
 * churn during the cutover; they can be removed once the routes stop
 * calling them.
 */
import { createEmptyCompanySnapshot } from "@arceus/company-runtime";
import type { ChatMessage } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";

/**
 * Update the company's currentSprintId / currentSprintNumber pointer.
 * Pulled out of the company row updater so callers don't have to
 * read-modify-write the whole company.
 *
 * Audit C8 — atomic via `db.transaction`.
 */
export async function updateCompanySprint(
  companyId: string,
  sprintId: string | null,
  sprintNumber: number | null,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await companiesRepo.lockForUpdate(tx, companyId);
    const company = await companiesRepo.findByIdHydrated(tx, companyId);
    if (!company) return;
    await companiesRepo.upsertCompany(tx, {
      ...company,
      currentSprintId: sprintId,
      currentSprintNumber: sprintNumber,
    });
  });
}

export async function updateCompanyStatus(
  companyId: string,
  status: import("@arceus/contracts").CompanyStatus,
): Promise<void> {
  await companiesRepo.setCompanyStatus(getDb(), companyId, status);
}

// ─── Board chat ───────────────────────────────────────────────────

export async function appendChatMessage(message: ChatMessage): Promise<ChatMessage> {
  await boardMessagesRepo.upsertChatMessage(getDb(), message);
  return message;
}

// ─── Lifecycle no-ops (kept for caller compat) ────────────────────
//
// Pre-7.C.d these touched the in-memory snapshot. Post-7.C.d every
// mutation goes straight to the DB, so these have nothing to do.
// Kept as no-ops so route handlers don't churn during the cutover.
// Safe to delete entirely once routes/company.routes.ts stops calling them.

export function resetCompany(): import("@arceus/contracts").CompanySnapshot {
  // Return the empty-snapshot shape so the existing return-type
  // contract is preserved for the route handler.
  return createEmptyCompanySnapshot();
}

/**
 * Pre-7.C.d this dropped the company_states row for a company.
 * The legacy `company_states` table is being dropped in 7.C.d, so
 * this becomes a no-op the moment the migration lands.
 */
export async function clearPersistedStoreState(_companyId: string): Promise<void> {
  // Intentionally empty — see file-level comment.
}

/**
 * Pre-7.C.d this returned the in-memory event log. Post-7.C.d the log
 * lives in `event_log` (canonical) and the SSE stream reads from there
 * directly. Until that wire-up exists, return [] so consumers aren't
 * broken.
 */
export function getEvents(): import("@arceus/contracts").EventEnvelope[] {
  return [];
}
