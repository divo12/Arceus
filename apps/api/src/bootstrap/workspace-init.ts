/**
 * Bootstrap — workspace + persistence + skill-registry hydration.
 * Spec 34 v3 PR 12.
 *
 * Runs once at boot, before route registration:
 *   - Sets the build-check working dir so cpLoadAgentContext can refresh
 *     the cached "is the workspace building?" status during beats.
 *   - Hydrates the in-memory mutation queue from canonical state.
 *   - Loads the active companyId so sync callers (route handlers, fire-
 *     and-forget reactive paths) can resolve it on first request.
 *   - For every existing company, hydrates the skill registry from DB
 *     (telemetry: successRate / usageCount / lastUsedAt) then re-runs
 *     the filesystem seed in `preserve` mode so new SKILL.md files
 *     added on disk get added without clobbering DB-backed telemetry.
 */
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { seedExistingSkills } from "@arceus/company-runtime";
import { hydrate } from "../persistence/mutations/index.js";
import { cpSetBuildCheckDir } from "../persistence/control-plane/index.js";
import { getMostRecentCompanyId } from "../companies/resolve-company.js";
import { hydrateSkillRegistryFromDb } from "../skills/db-writethrough.js";
import { workspaceManager } from "../workspace/manager.js";
import { materializeStaticSkillsForCompany } from "../opencode/materialize-static-skills.js";

export async function initWorkspaceAndPersistence(): Promise<void> {
  const persistenceMode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
  console.log(`[STARTUP] Company state persistence mode: ${persistenceMode}`);
  await hydrate();

  // Native multi-tenant: no global active-company pointer. Seed the boot
  // build-check dir from the most-recent company (a best-effort default for the
  // shared workspace; per-beat paths resolve their own tenant). Falls back to
  // the shared workspace root on first boot (no company yet).
  const bootCompanyId = await getMostRecentCompanyId();
  const productDir = bootCompanyId
    ? workspaceManager.getLocalPath(bootCompanyId)
    : workspaceManager.getLegacyProductDir();
  cpSetBuildCheckDir(productDir);

  await hydrateSkillRegistries(bootCompanyId);
}

async function hydrateSkillRegistries(bootCompanyId: string | null): Promise<void> {
  try {
    const companies = await companiesRepo.listCompanies(getDb());
    for (const company of companies) {
      const companyId = company.friendlyId ?? company.id;
      await hydrateSkillRegistryFromDb(companyId);
      seedExistingSkills(companyId, { mode: "preserve" });
    }
    if (companies.length > 0) {
      console.log(`[STARTUP] Skill registry hydrated for ${companies.length} compan${companies.length === 1 ? "y" : "ies"}.`);
    }

    // Materialize the boot company's skill set once to the shared workspace
    // dir (best-effort). New-company creation also triggers a materialize via
    // companies/bootstrap.ts; per-beat paths materialize their own tenant.
    if (bootCompanyId) {
      try {
        await materializeStaticSkillsForCompany(bootCompanyId);
      } catch (err) {
        console.warn(`[STARTUP] Static skill materialization failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.warn(`[STARTUP] Skill registry hydration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
