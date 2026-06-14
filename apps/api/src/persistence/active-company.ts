/**
 * Legacy single-company tenancy seam — BEING RETIRED (reliability overhaul,
 * 2026-06-14). See plans/reliability-overhaul.md Phase 2.
 *
 * Native multi-tenancy is now the rule: every authenticated request, beat,
 * sprint, artifact, control-plane, and route path resolves its own companyId
 * from its request/beat context (60+ former call sites converted). This module
 * survives ONLY as a narrow fallback for three contexts that don't yet carry an
 * explicit tenant and need a focused redesign to remove:
 *   1. agents/chat.ts — the unauthenticated `/api/chat/ceo` legacy path.
 *   2. meetings/runtime.ts — `getSnapshotForPackages`, a meeting-pipeline
 *      dependency bound once at scheduler construction (company-runtime change).
 *   3. bootstrap/* — boot-time workspace hydration + the post-bootstrap setter.
 *
 * IMPORTANT: the DANGER of a stale pointer is already removed — MCP tenant
 * resolution validates the resolved company is live (see live-companies.ts +
 * routes/internal-mcp/middleware.ts), so a deleted/wrong company can never be
 * served to a live request even via this seam.
 *
 * Do NOT add new readers. New code threads companyId explicitly (routes:
 * `companyIdOf(request)` / `request.companyId`; deep fns: a required param).
 *
 * Implementation:
 *   - Module-local `activeCompanyId` variable.
 *   - `setActiveCompanyId` is called by `bootstrapCompanyTx` after commit.
 *   - `loadActiveCompanyIdFromCanonical()` populates it at startup.
 *   - `clearActiveCompanyId` is called by reset / teardown paths.
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
 * Set the active company id.
 *
 * Single-tenant legacy seam: kept so the small set of remaining
 * `getActiveCompanyId()` readers (deep persistence/orchestration
 * code paths that don't have `req` in scope) have a sensible
 * non-null default after the FIRST bootstrap. Multi-tenant callers
 * resolve companyId from `req.companyId` (JWT) and don't touch this.
 *
 * History note: this function used to also call `cancelStaleBeats`
 * for the *previous* company when the singleton flipped — that side
 * effect made sense in single-company-per-process mode (dev tooling
 * switching between companies) but became a footgun in multi-tenant:
 * when user B bootstrapped a new company, user A's in-flight beats
 * got cancelled mid-flight as collateral damage. The cancellation
 * cascade has been removed; explicit cancels happen via
 * `cancelInFlightBeatsForCompany` from `orchestrator.routes` and
 * `company.routes` reset paths, which is the correct place for them.
 */
export function setActiveCompanyId(id: string): void {
  activeCompanyId = id;
}

/**
 * Clear the active company id. No longer cascades cancels — callers
 * that genuinely want to tear down a company's in-flight work invoke
 * `cancelInFlightBeatsForCompany` explicitly first.
 */
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
