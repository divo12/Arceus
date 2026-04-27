/**
 * Spec 31 Phase 7.C.d-cp — minimal test-compat re-export.
 *
 * Production code does NOT import from this file. The mutator surface
 * lives in `mutations.ts`; bootstrap / strategy / reset workflows live
 * in their domain folders (`companies/`, `sprints/`).
 *
 * The only remaining surface is `bootstrapCompany` for older test
 * fixtures (`routes/internal-mcp/*.test.ts`) that call it during
 * setup. Once those tests migrate to direct repo seeding or the
 * transactional API, this file is deleted in earnest.
 */
export { bootstrapCompanyTx as bootstrapCompany } from "../companies/bootstrap.js";
