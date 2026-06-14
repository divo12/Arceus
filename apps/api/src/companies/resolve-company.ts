/**
 * Most-recent-company resolution — the canonical replacement for the deleted
 * global active-company pointer.
 *
 * A handful of contexts legitimately need "a" company without a per-request
 * tenant: boot-time workspace/skill seeding (which company's dir to warm) and
 * the unauthenticated `/api/chat/ceo` legacy path. They used to read the
 * in-memory `getActiveCompanyId()` singleton, which could go stale. These now
 * read fresh DB truth each call via `getMostRecentCompanyId()`.
 *
 * `pickMostRecentCompanyId` is the pure selection (unit-tested); the async
 * wrapper does the single canonical read. Mirrors `fromDbId` (= friendlyId ?? id).
 */
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";

interface CompanyRowLike {
  id: string;
  friendlyId: string | null;
  createdAt: Date;
}

/** Pure: the most-recently-created company's friendly id, or null when none. */
export function pickMostRecentCompanyId(rows: readonly CompanyRowLike[]): string | null {
  if (rows.length === 0) return null;
  let latest = rows[0];
  for (const r of rows) {
    if (r.createdAt.getTime() > latest.createdAt.getTime()) latest = r;
  }
  return latest.friendlyId ?? latest.id;
}

/** Resolve the most-recent company's friendly id from canonical, or null. */
export async function getMostRecentCompanyId(): Promise<string | null> {
  const all = await companiesRepo.listCompanies(getDb());
  return pickMostRecentCompanyId(all);
}
