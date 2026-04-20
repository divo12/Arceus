/**
 * materializeBeatSkills — write SkillArtifact registry contents to disk so
 * OpenCode's native skill loader can read them for this beat.
 *
 * Phase 6 scope: write `<workDir>/.opencode/skills/<slug>/SKILL.md` plus any
 * resources, and `<workDir>/.opencode/arceus-skills.json` manifest. Symlink
 * swap to `/tmp/arceus/beats/<beatId>/skills/` is Phase 6.5 (package C); this
 * function just materializes to the provided workDir directly.
 *
 * Trust-band filter is minimal in v1:
 *   - probation: only skills with successRate ≥ 0.75 AND usageCount ≥ 20
 *   - standard | senior: all active skills
 * Full policy matrix is Phase 7+.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillArtifact, SkillResource } from "@arceus/contracts";
import { getSkillsForRole } from "@arceus/company-runtime";

export type TrustBand = "probation" | "standard" | "senior";

export interface MaterializeBeatSkillsInput {
  beatId: string;
  companyId: string;
  role: string;
  trustBand: TrustBand;
  /** Absolute path to the workspace whose `.opencode/skills/` will receive the tree. */
  workDir: string;
}

export interface MaterializedSkill {
  slug: string;
  skillId: string;
  version: number;
}

export type SkillManifest = Record<string, { skillId: string; version: number }>;

/** Slugify a skill name into a filesystem-safe directory name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "skill";
}

function trustBandAllows(band: TrustBand, skill: SkillArtifact): boolean {
  if (band === "probation") {
    return skill.successRate >= 0.75 && skill.usageCount >= 20;
  }
  return true;
}

/** Render a SkillArtifact to a SKILL.md body with Arceus metadata frontmatter. */
export function renderSkillMd(skill: SkillArtifact): string {
  const lines: string[] = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.trigger}`,
    "metadata:",
    "  arceus:",
    `    id: ${skill.id}`,
    `    version: ${skill.version}`,
    `    role: ${skill.role}`,
    `    status: ${skill.status}`,
    "---",
    "",
    skill.content.trim(),
    "",
  ];
  return lines.join("\n");
}

async function writeResource(skillDir: string, resource: SkillResource): Promise<void> {
  const abs = join(skillDir, resource.path);
  await mkdir(dirname(abs), { recursive: true });
  const data = resource.encoding === "base64"
    ? Buffer.from(resource.content, "base64")
    : resource.content;
  await writeFile(abs, data);
}

/**
 * Materialize the role's active skills into `<workDir>/.opencode/skills/`.
 *
 * Clears the skills directory first so stale skills from a previous beat don't
 * bleed into this one. Writes `arceus-skills.json` alongside as the manifest
 * the plugin uses to resolve `slug → { skillId, version }` for the usage POST.
 */
export async function materializeBeatSkills(
  input: MaterializeBeatSkillsInput,
): Promise<MaterializedSkill[]> {
  const opencodeDir = join(input.workDir, ".opencode");
  const skillsDir = join(opencodeDir, "skills");

  // Clear and recreate the skills dir so stale entries don't leak in.
  await rm(skillsDir, { recursive: true, force: true });
  await mkdir(skillsDir, { recursive: true });

  const active = getSkillsForRole(input.companyId, input.role)
    .filter((s) => s.status === "active")
    .filter((s) => trustBandAllows(input.trustBand, s));

  const manifest: SkillManifest = {};
  for (const artifact of active) {
    const slug = slugify(artifact.name);
    const skillDir = join(skillsDir, slug);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), renderSkillMd(artifact), "utf8");
    for (const resource of artifact.resources ?? []) {
      await writeResource(skillDir, resource);
    }
    manifest[slug] = { skillId: artifact.id, version: artifact.version };
  }

  await writeFile(
    join(opencodeDir, "arceus-skills.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return Object.entries(manifest).map(([slug, m]) => ({ slug, ...m }));
}
