/**
 * Spec 31 Phase 7.C.d-cp / 7.C.1 — minimal test-compat re-exports.
 *
 * Production code does NOT import from this file. The mutator surface
 * lives in `mutations.ts`; bootstrap / strategy / reset workflows live
 * in their domain folders (`companies/`, `sprints/`).
 *
 * The remaining surface keeps a few legacy phase-E/F/G internal-mcp
 * test fixtures compiling. Those tests are not part of the default
 * `npm test` run (only `verification-gate.test.ts` is). They remain
 * here only so `tsc --noEmit` stays green; the symbols are wired to
 * their canonical replacements where possible. Once those tests are
 * migrated to direct repo seeding / `buildSnapshotView`, this file
 * is deleted in earnest.
 */
import type { CompanySnapshot } from "@arceus/contracts";
import { createEmptyCompanySnapshot } from "@arceus/company-runtime";

export { bootstrapCompanyTx as bootstrapCompany } from "../companies/bootstrap.js";
export { upsertSprint, upsertTask } from "./mutations.js";

/**
 * Test-only sync stub. Returns an empty snapshot so legacy tests that
 * inspect `.sprints` / `.approvals` arrays compile. Production code
 * uses the async `buildSnapshotView(companyId)` from `orchestration/
 * snapshot-view.ts` instead.
 */
export function getSnapshot(): CompanySnapshot {
  return createEmptyCompanySnapshot();
}
