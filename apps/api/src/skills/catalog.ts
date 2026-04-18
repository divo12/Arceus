import { getSnapshot } from "../persistence/store.js";
import {
  seedExistingSkills,
  getSkillsForRole as registryGetSkillsForRole,
} from "@arceus/company-runtime";

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

/**
 * Tier-1 skill catalog (progressive disclosure): a compact one-line-per-skill
 * summary for ALL active skills this role has. Fed to the classifier so the
 * LLM can choose which skills apply — no embeddings, no thresholds.
 */
export function buildSkillCatalog(
  role: string,
): Array<{ id: string; name: string; trigger: string; successRate: number; version: number }> {
  ensureSkillsSeeded();
  const snapshot = getSnapshot();
  const skills = registryGetSkillsForRole(snapshot.company.id, role);
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    trigger: s.trigger,
    successRate: s.successRate,
    version: s.version,
  }));
}

/**
 * Build the skill section injected into an agent's system prompt (tier-2:
 * full skill bodies). When `matchedSkillIds` is provided, only those skills'
 * bodies are rendered. When omitted, all active role skills are rendered
 * (legacy direct-session paths).
 */
export function buildSkillSection(
  role: string,
  matchedSkillIds?: string[],
  cap = 3,
): string {
  ensureSkillsSeeded();
  const snapshot = getSnapshot();
  let skills = registryGetSkillsForRole(snapshot.company.id, role);
  if (skills.length === 0) return "";

  if (matchedSkillIds && matchedSkillIds.length > 0) {
    const idSet = new Set(matchedSkillIds);
    skills = skills.filter((s) => idSet.has(s.id)).slice(0, cap);
  }
  if (skills.length === 0) return "";

  const lines = [
    "",
    "## Relevant Skills",
    "The following procedural skills are available for this task:",
  ];
  for (const skill of skills) {
    lines.push(
      "",
      `### ${skill.name} (v${skill.version}, success: ${Math.round(skill.successRate * 100)}%)`,
      `Trigger: ${skill.trigger}`,
      skill.content,
    );
  }
  return lines.join("\n");
}

/** @deprecated Use buildSkillSection(role, undefined) — kept for call sites that haven't migrated. */
export function buildSkillMenu(role: string): string {
  return buildSkillSection(role);
}

/** @deprecated Use buildSkillSection(role, undefined) — kept for call sites that haven't migrated. */
export function getSkillBody(role: string, skillName?: string): string {
  if (skillName) {
    ensureSkillsSeeded();
    const snapshot = getSnapshot();
    const skills = registryGetSkillsForRole(snapshot.company.id, role);
    const match = skills.find((s) => s.name === skillName);
    return match ? `\n# Skill: ${match.name}\n\n${match.content}` : "";
  }
  return "";
}
