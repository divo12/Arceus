/**
 * Regenerate .opencode/prompts/<role>-soul.txt from the TS source of truth
 * (packages/company-runtime employee prompts), mirroring what
 * apps/api/src/infra/opencode.ts writes into the workspace at boot.
 *
 * The runtime regenerates these at every boot, so the repo copies are
 * only read pre-sync (fresh checkouts, local opencode runs) — but stale
 * copies are misleading. Run after any soul edit:
 *
 *   npx tsx scripts/regen-soul-prompts.ts
 */
import { ROLES, ROLE_CONFIGS } from "../.opencode/agent/config.js";
import { getRoleSoul } from "@arceus/company-runtime";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const role of ROLES) {
  const basename = ROLE_CONFIGS[role].promptFile.split("/").pop();
  if (!basename) continue;
  const soul = getRoleSoul(role);
  if (!soul?.systemPrompt) continue;
  writeFileSync(resolve(repoRoot, ".opencode/prompts", basename), soul.systemPrompt, "utf8");
  console.log(`wrote ${basename} (${soul.systemPrompt.length} chars)`);
}
