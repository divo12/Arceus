/**
 * Single-company tenancy seam — Spec 31 Phase 7.B.5 / 7.C.d.
 *
 * Arceus runs single-company-per-process today. The seam is a sync
 * read because most callers (route handlers, fire-and-forget reactive
 * paths, sync mutators) can't tolerate awaiting a DB roundtrip just
 * to learn which company they're operating against.
 *
 * Implementation:
 *   - Module-local `activeCompanyId` variable.
 *   - `setActiveCompanyId` is called by `bootstrapCompanyTx` after the
 *     transaction commits.
 *   - `loadActiveCompanyIdFromCanonical()` is called at server startup
 *     to populate it from the `companies` table when an existing
 *     company survived a process restart.
 *   - `clearActiveCompanyId` is called by reset / teardown paths.
 *
 * Multi-tenant T1+ replaces this with a per-request `companyContext`
 * middleware. Until then this is the single source of truth for "which
 * company is the current process serving."
 */
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";

let activeCompanyId: string | null = null;

/** Return the active company id or null when no company has been bootstrapped. */
export function getActiveCompanyId(): string | null {
  return activeCompanyId;
}

/** Return the active company id or throw a 409-shaped error when missing. */
export function requireActiveCompanyId(): string {
  if (!activeCompanyId) {
    throw new Error("No active company. Bootstrap a company before calling this endpoint.");
  }
  return activeCompanyId;
}

/**
 * Set the active company id. Called by `bootstrapCompanyTx` after the
 * transaction commits. Idempotent — safe to call with the same id.
 */
export function setActiveCompanyId(id: string): void {
  activeCompanyId = id;
}

/** Clear the active company id. Called by reset / teardown paths. */
export function clearActiveCompanyId(): void {
  activeCompanyId = null;
}

/**
 * Hydrate the active company id from canonical at server startup.
 * Picks the most-recently-created company row when multiple exist
 * (single-company-per-process today, so usually 0 or 1 rows).
 *
 * Returns the **friendly** id (`company_<uuid>`) so the active-id
 * shape matches what `bootstrapCompanyTx` writes via
 * `setActiveCompanyId`. Without `fromDbId`, we'd return the bare
 * canonical UUID column, which mismatches the friendly form used in
 * audit logs / string comparisons / event correlation. Repos
 * round-trip both forms through `toDbId`, but consistency at the
 * seam matters for everything that string-formats the id.
 */
export async function loadActiveCompanyIdFromCanonical(): Promise<string | null> {
  try {
    const all = await companiesRepo.listCompanies(getDb());
    if (all.length === 0) {
      activeCompanyId = null;
      return null;
    }
    // Pick the most recent; deterministic when there's just one.
    const sorted = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const row = sorted[0];
    activeCompanyId = companiesRepo.fromDbId(row.id, row.friendlyId);
    return activeCompanyId;
  } catch (err) {
    console.warn("[active-company] failed to load from canonical:", err);
    return null;
  }
}
