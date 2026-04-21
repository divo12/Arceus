/**
 * materializeBeatSkills — write SkillArtifact registry contents to disk so
 * OpenCode's native skill loader can read them for this beat.
 *
 * Phase 6.5 (package D): materializer writes to `beatSkillsDir(beatId)` and
 * swaps the productWorkspace symlink so OpenCode reads the materialized tree.
 * The manifest (`arceus-skills.json`) goes into `productWorkspace/.opencode/`
 * so the plugin finds it at its known path.
 *
 * Legacy `workDir` parameter is still accepted for backward compatibility
 * with existing tests; when omitted the new beat-paths are used.
 *
 * Trust-band filter is minimal in v1:
 *   - probation: only skills with successRate ≥ 0.75 AND usageCount ≥ 20
 *   - standard | senior: all active skills
 * Full policy matrix is Phase 7+.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SkillArtifact, SkillResource } from "@arceus/contracts";
import { getSkillsForRole } from "@arceus/company-runtime";
import { beatSkillsDir, swapSkillsSymlink } from "../infra/beat-paths.js";
import { productWorkspace } from "../infra/opencode.js";

export type TrustBand = "probation" | "standard" | "senior";

export interface MaterializeBeatSkillsInput {
  beatId: string;
  companyId: string;
  role: string;
  trustBand: TrustBand;
  /**
   * Legacy: absolute path to the workspace whose `.opencode/skills/` will
   * receive the tree. When omitted, writes to `beatSkillsDir(beatId)` and
   * swaps the productWorkspace symlink (Phase 6.5 mode).
   */
  workDir?: string;
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

/**
 * Reject resource paths that are absolute or escape `skillDir` via `..`.
 * Skill resources come from the registry, which ultimately accepts
 * user-authored skill definitions — we cannot trust them to stay in-bounds.
 */
function resolveSafeResourcePath(skillDir: string, resourcePath: string): string {
  if (isAbsolute(resourcePath)) {
    throw new Error(`Skill resource path must be relative: ${resourcePath}`);
  }
  const skillDirResolved = resolve(skillDir);
  const abs = resolve(skillDirResolved, resourcePath);
  const rel = relative(skillDirResolved, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Skill resource path escapes skill dir: ${resourcePath}`);
  }
  return abs;
}

async function writeResource(skillDir: string, resource: SkillResource): Promise<void> {
  const abs = resolveSafeResourcePath(skillDir, resource.path);
  await mkdir(dirname(abs), { recursive: true });
  const data = resource.encoding === "base64"
    ? Buffer.from(resource.content, "base64")
    : resource.content;
  await writeFile(abs, data);
}

/**
 * Materialize the role's active skills.
 *
 * When `workDir` is provided (legacy / test mode): writes into
 * `<workDir>/.opencode/skills/` and manifest alongside — no symlink swap.
 *
 * When `workDir` is omitted (Phase 6.5 mode): writes skills into
 * `beatSkillsDir(beatId)`, writes manifest to `productWorkspace/.opencode/`,
 * and swaps the `productWorkspace/.opencode/skills` symlink to point at the
 * beat's skill tree.
 */
export async function materializeBeatSkills(
  input: MaterializeBeatSkillsInput,
): Promise<MaterializedSkill[]> {
  const useLegacy = !!input.workDir;
  const skillsDir = useLegacy
    ? join(input.workDir!, ".opencode", "skills")
    : beatSkillsDir(input.beatId);
  const manifestDir = useLegacy
    ? join(input.workDir!, ".opencode")
    : join(productWorkspace, ".opencode");

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

  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, "arceus-skills.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  // Phase 6.5: swap the symlink so OpenCode reads from this beat's skills dir.
  if (!useLegacy) {
    await swapSkillsSymlink(skillsDir);
  }

  return Object.entries(manifest).map(([slug, m]) => ({ slug, ...m }));
}
