import { getActiveCompanyId } from "../persistence/active-company.js";
import { seedExistingSkills } from "@arceus/company-runtime";
import { hydrateSkillRegistryFromDb, isSkillsDbWritethroughEnabled } from "./db-writethrough.js";

/**
 * Ensure skills are seeded from Markdown files on first use.
 * Idempotent — no-op if already seeded.
 *
 * When ARCEUS_SKILLS_DB_WRITETHROUGH=1, returns a Promise that resolves once
 * DB hydration completes, then the Markdown seed runs in "preserve" mode
 * (DB rows win on collision). Without the flag, it's synchronous.
 *
 * Spec 31 Phase 7.C.c — companyId via the seam helper. Silently no-ops
 * before bootstrap because the skill registry is per-company.
 */
export function ensureSkillsSeeded(): void {
  const companyId = getActiveCompanyId();
  if (!companyId) return;

  if (isSkillsDbWritethroughEnabled()) {
    // Fire-and-forget hydration. The Markdown seed below uses the default
    // "preserve" mode so any skill name already loaded from DB is skipped.
    void hydrateSkillRegistryFromDb(companyId).then(() => {
      const count = seedExistingSkills(companyId);
      if (count > 0) {
        console.log(`[SkillRegistry] Seeded ${count} new skills from Markdown for company ${companyId}`);
      }
    });
    return;
  }

  const count = seedExistingSkills(companyId);
  if (count > 0) {
    console.log(`[SkillRegistry] Seeded ${count} skills for company ${companyId}`);
  }
}
