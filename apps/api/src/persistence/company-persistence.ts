/**
 * Company persistence helper — Spec 31 Phase 7.C.d.
 *
 * Post-7.C.d, the in-memory snapshot is gone. `persistCompany(companyId)`
 * is now a thin re-up of the canonical row read directly from the DB.
 * It survives as a name because `task-persistence.ts` still calls it as
 * an FK-retry helper (read-modify-write the company row when a child
 * insert hits 23503).
 */
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import postgres from "postgres";
import { observability } from "@arceus/contracts";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

/**
 * Re-upsert the company row keyed by id. Used by the FK-retry path in
 * `task-persistence.ts` to make sure the parent row exists before
 * retrying a child insert. No-op if the row doesn't exist.
 */
export async function persistCompany(companyId: string): Promise<void> {
  const company = await companiesRepo.findByIdHydrated(getDb(), companyId);
  if (!company) return;
  try {
    await companiesRepo.upsertCompany(getDb(), company);
  } catch (err) {
    const code = pgErrorCode(err);
    console.warn(`[companies] DB sync skipped for ${companyId} (pg=${code})`);
    observability.logEvent({
      event: "persist.failed",
      table: "companies",
      id: companyId,
      pgCode: code,
      ts: Date.now(),
    });
  }
}
