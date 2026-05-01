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
import { loadActiveCompanyIdFromCanonical } from "../persistence/active-company.js";
import { hydrateSkillRegistryFromDb } from "../skills/db-writethrough.js";
import { workspaceManager } from "../workspace/manager.js";

export async function initWorkspaceAndPersistence(): Promise<void> {
  const productDir = workspaceManager.getLegacyProductDir();
  cpSetBuildCheckDir(productDir);

  const persistenceMode = (process.env.ARCEUS_PERSISTENCE_MODE ?? "local").trim().toLowerCase();
  console.log(`[STARTUP] Company state persistence mode: ${persistenceMode}`);
  await hydrate();

  // Spec 31 Phase 7.C.d — populate the active-company seam from canonical so
  // sync callers (route handlers, fire-and-forget reactive paths) can resolve
  // companyId immediately on first request after a restart.
  await loadActiveCompanyIdFromCanonical();

  await hydrateSkillRegistries();
}

async function hydrateSkillRegistries(): Promise<void> {
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
  } catch (err) {
    console.warn(`[STARTUP] Skill registry hydration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
