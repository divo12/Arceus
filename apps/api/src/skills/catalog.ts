import { getSnapshot } from "../persistence/store.js";
import { seedExistingSkills } from "@arceus/company-runtime";

/**
 * Ensure skills are seeded from Markdown files on first use.
 * Idempotent — no-op if already seeded.
 */
export function ensureSkillsSeeded(): void {
  const snapshot = getSnapshot();
  const companyId = snapshot.company.id;
  if (!companyId || companyId === "company_empty") return;
  const count = seedExistingSkills(companyId);
  if (count > 0) {
    console.log(`[SkillRegistry] Seeded ${count} skills for company ${companyId}`);
  }
}
