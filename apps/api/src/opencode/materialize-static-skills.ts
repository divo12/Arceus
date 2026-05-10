/**
 * Static skill materialization — V1 simplification.
 *
 * Replaces the per-beat materialize+symlink-swap dance (Phase 6.5) with a
 * single boot-time write of every active skill to a shared dir. OpenCode
 * resolves `skill({name: <slug>})` against `cwd/.opencode/skills/<slug>/
 * SKILL.md`, so dropping all skills into one physical directory means
 * every agent that has `skill: true` in its frontmatter can call any
 * registered slug. Soft separation between roles relies on (a) the
 * agent's prompt naming the slugs it should use and (b) slug naming
 * conventions (e.g. `ui-*`, `dev-*`). A future iteration can add hard
 * isolation via per-role subdirs + symlink swap if needed.
 *
 * Why drop the per-beat materializer:
 *   1. Skills don't change per beat. The per-beat write was paying for
 *      a non-existent invariant.
 *   2. The cache + hash + symlink machinery added ~150 lines of code
 *      that obscured the boot path and made a rare class of bug
 *      possible (stale symlink → wrong company's skills served).
 *   3. The per-beat dir was anchored at productWorkspace, which means
 *      the symlink was already shared across roles within a beat
 *      window — the "isolation" was already cosmetic.
 *
 * Trade-offs:
 *   • Mutations (skill_mutator approving a new version) are no longer
 *     reflected on disk until next boot. V1 fix-up: re-call the
 *     materializer from a registry-mutation hook. Skipped for now —
 *     mutations are infrequent and the boot path covers seed evolution.
 *   • Multi-company servers see the LAST materialized company's skills
 *     in productWorkspace. The runtime is currently single-active-company
 *     so this is fine; if that changes we'll need per-company workspaces.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillArtifact } from "@arceus/contracts";
import { getAllSkills } from "@arceus/company-runtime";
import { productWorkspace } from "../infra/opencode.js";
import {
  slugify,
  renderSkillMd,
  type MaterializedSkill,
  type SkillManifest,
} from "./materialize-beat-skills.js";

const skillsDir = (): string => join(productWorkspace, ".opencode", "skills");
const manifestPath = (): string =>
  join(productWorkspace, ".opencode", "arceus-skills.json");

/**
 * Write every active skill for the given company to the shared
 * `productWorkspace/.opencode/skills/` directory and refresh the
 * manifest at `productWorkspace/.opencode/arceus-skills.json`.
 *
 * Idempotent — the dir is wiped and rewritten each call, so deprecated
 * or removed skills disappear from disk on the next call. Multi-role
 * fan-out skills (e.g. `plan-task-graph` registered for both cto and
 * pm) deduplicate on slug; the first registry entry wins because
 * seed content is identical across roles.
 */
export async function materializeStaticSkillsForCompany(
  companyId: string,
): Promise<MaterializedSkill[]> {
  const allSkills = getAllSkills(companyId).filter((s) => s.status === "active");

  // Dedupe on slug. Multi-role seeds like `plan-task-graph: cto,pm` fan
  // out to two registry rows with identical content; on disk we only
  // need one SKILL.md per name. Keep the first occurrence so the manifest
  // entry is deterministic on repeated boots.
  const bySlug = new Map<string, SkillArtifact>();
  for (const skill of allSkills) {
    const slug = slugify(skill.name);
    if (!bySlug.has(slug)) bySlug.set(slug, skill);
  }

  const dir = skillsDir();
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const manifest: SkillManifest = {};
  for (const [slug, skill] of bySlug) {
    const skillDir = join(dir, slug);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), renderSkillMd(skill), "utf8");
    manifest[slug] = { skillId: skill.id, version: skill.version };
  }

  await writeFile(
    manifestPath(),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `[materializeStaticSkills] wrote ${bySlug.size} skill(s) to ${dir} for company ${companyId}`,
  );

  return [...bySlug.entries()].map(([slug, s]) => ({
    slug,
    skillId: s.id,
    version: s.version,
  }));
}
