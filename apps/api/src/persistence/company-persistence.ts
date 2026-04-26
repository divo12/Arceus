/**
 * Company persistence dual-write — Phase 4A.
 *
 * Same pattern as `task-persistence.ts`: route + store mutators call
 * `persistCompany(companyId)` after every change to keep the Postgres
 * row in sync with the in-memory snapshot. Read-fallback isn't needed
 * here today — every consumer reads `getSnapshot().company` directly,
 * not by id — so we ship the write path now and migrate readers in a
 * later phase if the use case appears.
 *
 * Failures are logged with the postgres error code and never thrown;
 * the store remains authoritative until Phase 5+ migrates company
 * readers off `getSnapshot()`.
 */
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import postgres from "postgres";
import { getSnapshot } from "./store.js";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

/**
 * Persist the current `snapshot.company` to the DB. Called after every
 * store mutation that touches the company row (bootstrapCompany,
 * updateCompanyStatus, updateCompanySprint, strategy approval, budget
 * spend, etc.). The store stays authoritative; the DB row is kept in
 * sync so Phase 3C+ task FK writes succeed.
 */
export async function persistCompany(companyId: string): Promise<void> {
  const company = getSnapshot().company;
  if (!company || company.id !== companyId) return;
  // Don't persist the placeholder company id used before bootstrap —
  // it has no `boardOwner`, no real budget, and no strategy id; the
  // upsert would write a useless row that confuses anyone debugging
  // the table.
  if (company.id === "company_pending") return;
  try {
    await companiesRepo.upsertCompany(getDb(), company);
  } catch (err) {
    console.warn(`[companies] DB sync skipped for ${companyId} (pg=${pgErrorCode(err)})`);
  }
}
