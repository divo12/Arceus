/**
 * Spec 14 – Phase 1: Skill Registry
 *
 * In-memory skill registry with optional DB persistence.
 * Skills are versioned, mutable artifacts that agents use as procedural guidance.
 *
 * Two modes:
 *   - In-memory only (no DB configured): skills live in a Map, lost on restart
 *   - DB-backed: skills persisted to skill_artifacts table, in-memory as read cache
 *
 * Singleton access via getSkillRegistry().
 */

import type { SkillArtifact, SkillHealthReport, SkillMutation, FailureAttribution } from "@arceus/contracts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ── In-memory store ───────────────────────────────────────

/** All skills indexed by id */
const skillsById = new Map<string, SkillArtifact>();

/** Active skills indexed by companyId:role for fast lookup */
const activeSkillIndex = new Map<string, SkillArtifact[]>();

let seeded = false;

function activeKey(companyId: string, role: string): string {
  return `${companyId}:${role}`;
}

function rebuildActiveIndex(): void {
  activeSkillIndex.clear();
  for (const skill of skillsById.values()) {
    if (skill.status !== "active") continue;
    const key = activeKey(skill.companyId, skill.role);
    const existing = activeSkillIndex.get(key) ?? [];
    existing.push(skill);
    activeSkillIndex.set(key, existing);
  }
}

// ── CRUD operations ───────────────────────────────────────

export function registerSkill(skill: SkillArtifact): void {
  skillsById.set(skill.id, { ...skill });
  rebuildActiveIndex();
}

export function updateSkill(skillId: string, updates: Partial<SkillArtifact>): SkillArtifact | null {
  const existing = skillsById.get(skillId);
  if (!existing) return null;
  const updated: SkillArtifact = { ...existing, ...updates };
  skillsById.set(skillId, updated);
  rebuildActiveIndex();
  return updated;
}

export function deprecateSkill(skillId: string, reason: string): boolean {
  const existing = skillsById.get(skillId);
  if (!existing) return false;
  skillsById.set(skillId, {
    ...existing,
    status: "deprecated",
    mutationReason: reason,
  });
  rebuildActiveIndex();
  return true;
}

export function getSkillById(skillId: string): SkillArtifact | null {
  return skillsById.get(skillId) ?? null;
}

// ── Query operations ──────────────────────────────────────

/**
 * Get all active skills for a given role.
 */
export function getSkillsForRole(companyId: string, role: string): SkillArtifact[] {
  return activeSkillIndex.get(activeKey(companyId, role)) ?? [];
}

/**
 * Get all skills (any status) for a company.
 */
export function getAllSkills(companyId: string): SkillArtifact[] {
  const results: SkillArtifact[] = [];
  for (const skill of skillsById.values()) {
    if (skill.companyId === companyId) results.push(skill);
  }
  return results;
}

/**
 * Get version history for a skill (all versions with same company + name).
 */
export function getSkillHistory(companyId: string, skillName: string): SkillArtifact[] {
  const results: SkillArtifact[] = [];
  for (const skill of skillsById.values()) {
    if (skill.companyId === companyId && skill.name === skillName) {
      results.push(skill);
    }
  }
  return results.sort((a, b) => a.version - b.version);
}

/**
 * Match skills relevant to a task description using token overlap.
 * Returns 0-3 best-matching active skills for the role, sorted by relevance.
 */
export function matchSkills(
  companyId: string,
  role: string,
  taskDescription: string,
): SkillArtifact[] {
  const roleSkills = getSkillsForRole(companyId, role);
  if (roleSkills.length === 0) return [];

  const taskTokens = tokenize(taskDescription);
  if (taskTokens.size === 0) return roleSkills.slice(0, 3);

  const scored = roleSkills.map((skill) => {
    const triggerTokens = tokenize(skill.trigger);
    const nameTokens = tokenize(skill.name);
    const allSkillTokens = new Set([...triggerTokens, ...nameTokens]);

    let overlap = 0;
    for (const token of taskTokens) {
      if (allSkillTokens.has(token)) overlap++;
    }

    const score = allSkillTokens.size > 0 ? overlap / allSkillTokens.size : 0;
    return { skill, score };
  });

  // Return skills with any overlap, sorted by score descending, max 3
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.skill);
}

// ── Usage tracking ────────────────────────────────────────

/**
 * Record that a skill was matched and used in a task.
 */
export function recordSkillUsage(skillId: string): void {
  const skill = skillsById.get(skillId);
  if (!skill) return;
  skillsById.set(skillId, {
    ...skill,
    usageCount: skill.usageCount + 1,
    lastUsedAt: new Date().toISOString(),
  });
}

/**
 * Update success rate using exponential moving average.
 * EMA: rate = rate * (1 - lr) + outcome * lr
 * lr = 0.15 (spec says 0.85/0.15 split)
 */
export function updateSuccessRate(skillId: string, outcome: number): void {
  const skill = skillsById.get(skillId);
  if (!skill) return;
  const lr = 0.15;
  const newRate = skill.successRate * (1 - lr) + outcome * lr;
  skillsById.set(skillId, {
    ...skill,
    successRate: Math.max(0, Math.min(1, newRate)),
  });
}

// ── Health metrics ────────────────────────────────────────

export function getSkillHealth(companyId: string): SkillHealthReport {
  const all = getAllSkills(companyId);
  const active = all.filter((s) => s.status === "active");

  const avgRate = active.length > 0
    ? active.reduce((sum, s) => sum + s.successRate, 0) / active.length
    : 0;

  const worstPerformers = active
    .filter((s) => s.successRate < 0.6)
    .sort((a, b) => a.successRate - b.successRate)
    .slice(0, 5)
    .map((s) => ({
      skillId: s.id,
      name: s.name,
      successRate: s.successRate,
      issues: [
        ...(s.successRate < 0.4 ? ["Critical: success rate below 40%"] : []),
        ...(s.successRate < 0.6 ? ["Low success rate"] : []),
        ...(s.usageCount === 0 ? ["Never used"] : []),
      ],
    }));

  return {
    totalSkills: all.length,
    activeSkills: active.length,
    averageSuccessRate: Math.round(avgRate * 100) / 100,
    worstPerformers,
    gaps: [],          // Phase 5 populates this from pattern analysis
    recentMutationCount: 0,  // Phase 2 tracks mutations
  };
}

// ── Seed + lifecycle ──────────────────────────────────────

export function isSeeded(): boolean {
  return seeded;
}

export function markSeeded(): void {
  seeded = true;
}

export function resetRegistry(): void {
  skillsById.clear();
  activeSkillIndex.clear();
  mutationsById.clear();
  attributionsStore.length = 0;
  seeded = false;
}

export function getRegistrySize(): number {
  return skillsById.size;
}

// ── Mutation + Attribution storage (Phase 2) ─────────────

const mutationsById = new Map<string, SkillMutation>();
const attributionsStore: FailureAttribution[] = [];

export function storeMutation(mutation: SkillMutation): void {
  mutationsById.set(mutation.id, { ...mutation });
}

export function getMutationById(id: string): SkillMutation | null {
  return mutationsById.get(id) ?? null;
}

export function updateMutationStatus(
  id: string,
  status: SkillMutation["status"],
  updates?: Partial<Pick<SkillMutation, "reviewFeedback" | "revisionCycle" | "testResults">>,
): SkillMutation | null {
  const existing = mutationsById.get(id);
  if (!existing) return null;
  const updated: SkillMutation = {
    ...existing,
    ...updates,
    status,
    resolvedAt: ["approved", "rejected", "merged"].includes(status)
      ? new Date().toISOString()
      : existing.resolvedAt,
  };
  mutationsById.set(id, updated);
  return updated;
}

export function getMutationsForCompany(companyId: string): SkillMutation[] {
  const results: SkillMutation[] = [];
  for (const m of mutationsById.values()) {
    if (m.companyId === companyId) results.push(m);
  }
  return results.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
}

export function getPendingMutations(companyId: string): SkillMutation[] {
  return getMutationsForCompany(companyId).filter(
    (m) => m.status === "proposed" || m.status === "revision",
  );
}

export function storeAttribution(attribution: FailureAttribution): void {
  attributionsStore.push({ ...attribution });
}

export function getAttributionsForCompany(companyId: string): FailureAttribution[] {
  // Attributions link to skills; for company filter, check if the skill belongs to this company.
  // Attributions with null skillId (gaps) are always returned.
  return attributionsStore.filter((a) => {
    if (!a.attributedSkillId) return true;
    const skill = skillsById.get(a.attributedSkillId);
    return skill?.companyId === companyId;
  });
}

/**
 * Apply a merged mutation: deprecate old skill version, register new as active.
 */
export function applyMergedMutation(mutation: SkillMutation): SkillArtifact {
  if (mutation.originalSkillId) {
    deprecateSkill(mutation.originalSkillId, mutation.reason);
  }
  const newSkill: SkillArtifact = {
    ...mutation.proposedSkill,
    status: "active",
    approvedAt: new Date().toISOString(),
  };
  registerSkill(newSkill);
  updateMutationStatus(mutation.id, "merged");
  return newSkill;
}

// ── Seed from Markdown files ──────────────────────────────

/**
 * Parse YAML-ish frontmatter from a skill Markdown file.
 * Returns { frontmatter, body }.
 */
function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const lines = match[1].split("\n");
  const frontmatter: Record<string, string> = {};
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      frontmatter[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
    }
  }
  return { frontmatter, body: match[2].trim() };
}

/**
 * Seed the registry from the 6 Markdown skill files on disk.
 * Idempotent — skips if already seeded or if skills already exist.
 *
 * @param companyId - The company to associate skills with
 * @param skillsDir - Optional override for the skills directory path
 * @returns Number of skills seeded
 */
export function seedExistingSkills(
  companyId: string,
  skillsDir?: string,
): number {
  if (seeded) return 0;

  // Resolve relative to this file so it works regardless of process.cwd()
  const thisDir = new URL(".", import.meta.url).pathname;
  const dir = skillsDir ?? resolve(thisDir, "..", "skills");
  if (!existsSync(dir)) {
    console.warn(`[SkillRegistry] Skills directory not found: ${dir}`);
    markSeeded();
    return 0;
  }

  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, "utf8");
    const { frontmatter, body } = parseSkillFrontmatter(raw);

    const name = frontmatter.name || entry.name;
    const role = frontmatter.role || "developer";

    // Skip if this skill already exists in the registry
    const existing = getSkillHistory(companyId, name);
    if (existing.length > 0) continue;

    const skill: SkillArtifact = {
      id: `skill-${name}-v1`,
      companyId,
      name,
      role,
      version: 1,
      status: "active",
      trigger: frontmatter.description || name,
      content: body,
      testCases: [],
      successRate: 0.7,    // seed skills start at 0.7 (trusted baseline)
      usageCount: 0,
      lastUsedAt: null,
      mutatedFromId: null,
      mutatedBy: null,
      mutationReason: null,
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    };

    registerSkill(skill);
    count++;
  }

  markSeeded();
  return count;
}

// ── Helpers ───────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "and", "but", "or", "nor", "not", "so", "yet",
  "this", "that", "these", "those", "it", "its", "they", "them",
  "when", "where", "how", "what", "which", "who", "whom",
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  return new Set(tokens);
}
