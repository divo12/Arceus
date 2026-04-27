/**
 * Single-company tenancy seam — Spec 31 Phase 7.B.5.
 *
 * Arceus is currently single-company-per-process. Many handlers historically
 * read `getSnapshot().company.id` to get the active company. This module
 * provides a stable seam they can call instead so the snapshot dependency
 * disappears once Phase 7.C retires `store.ts`.
 *
 * Resolution order:
 *   1. In-memory snapshot company id (still authoritative during B.5).
 *   2. Latest hydrated companyId persisted to `companies` table (fallback
 *      once B.5 cuts over and the in-memory snapshot is gone).
 *
 * Returns `null` (or throws via `requireActiveCompanyId`) when no company
 * has been bootstrapped yet — the caller decides which signal to surface.
 */
import { getSnapshot } from "./store.js";

const PENDING_COMPANY_ID = "company_pending";

/** Return the active company id or null when no company has been bootstrapped. */
export function getActiveCompanyId(): string | null {
  const snapshotId = getSnapshot().company.id;
  if (snapshotId && snapshotId !== PENDING_COMPANY_ID) return snapshotId;
  return null;
}

/** Return the active company id or throw a 409-shaped error when missing. */
export function requireActiveCompanyId(): string {
  const id = getActiveCompanyId();
  if (!id) {
    throw new Error("No active company. Bootstrap a company before calling this endpoint.");
  }
  return id;
}
