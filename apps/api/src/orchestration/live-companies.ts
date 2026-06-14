/**
 * Live-company registry — fail-safe substrate for MCP tenant resolution.
 *
 * The MCP middleware resolves a request's companyId from in-memory session
 * context. If a context lingers for a company that has since been deleted
 * (notably a raw DB wipe that bypassed `DELETE /api/company`, which would
 * otherwise have called `clearAllSessionContexts`), the request resolves to a
 * companyId that no longer exists → `buildSnapshotView: company X not found` →
 * 500. This registry lets the middleware reject such requests instead of
 * poisoning the request with a dead tenant.
 *
 * Sources of truth, in order of authority:
 *   - `markCompaniesLive(ids)` — called every heartbeat tick with the full DB
 *     company list. REPLACES the set, so a deleted company drops out within one
 *     tick.
 *   - `markCompanyLive(id)` — called on bootstrap so a brand-new company is
 *     live immediately, covering the window before the next tick refresh.
 *   - `forgetCompany(id)` — called on explicit company delete for instant
 *     removal (the tick would catch it anyway).
 *
 * Fail-OPEN: before the first refresh (`liveCompanyIds === null`) the truth is
 * unknown, so `isCompanyKnownLive` returns true — never reject at boot before
 * the registry is populated.
 *
 * Pure in-memory module (no DB import) so it is cheap to unit-test and safe to
 * read on the MCP hot path.
 */

let liveCompanyIds: Set<string> | null = null;

/** Replace the live set with the authoritative DB list (heartbeat tick). */
export function markCompaniesLive(ids: Iterable<string>): void {
  liveCompanyIds = new Set(ids);
}

/** Add a single company (bootstrap) without clearing the rest. */
export function markCompanyLive(id: string): void {
  if (liveCompanyIds === null) liveCompanyIds = new Set();
  liveCompanyIds.add(id);
}

/** Remove a single company immediately (explicit delete path). */
export function forgetCompany(id: string): void {
  liveCompanyIds?.delete(id);
}

/** True once any source has populated the registry at least once. */
export function isRegistryPopulated(): boolean {
  return liveCompanyIds !== null;
}

/**
 * True if the company is known to exist. Fail-open before the first refresh:
 * an unpopulated registry returns true so boot-time requests aren't rejected.
 */
export function isCompanyKnownLive(id: string): boolean {
  if (liveCompanyIds === null) return true;
  return liveCompanyIds.has(id);
}

/** Test-only: reset to the unpopulated state. */
export function __resetLiveCompanies(): void {
  liveCompanyIds = null;
}
