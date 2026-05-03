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

import type { SkillArtifact, SkillHealthReport, SkillMutation, FailureAttribution, SkillResource } from "@arceus/contracts";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { extname, join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Register or overwrite a skill in the in-memory store and rebuild the active index. */
export function registerSkill(skill: SkillArtifact): void {
  const next = { ...skill };
  skillsById.set(skill.id, next);
  rebuildActiveIndex();
  registryDeps?.onSkillUpserted?.(next);
}

/** Hydrate a skill into the in-memory store WITHOUT firing write-through callbacks.
 *  Used at boot when loading from DB so we don't write back to DB. */
export function hydrateSkill(skill: SkillArtifact): void {
  skillsById.set(skill.id, { ...skill });
  rebuildActiveIndex();
}

/** Apply partial updates to an existing skill, return the updated skill or null if not found. */
export function updateSkill(skillId: string, updates: Partial<SkillArtifact>): SkillArtifact | null {
  const existing = skillsById.get(skillId);
  if (!existing) return null;
  const updated: SkillArtifact = { ...existing, ...updates };
  skillsById.set(skillId, updated);
  rebuildActiveIndex();
  registryDeps?.onSkillUpserted?.(updated);
  return updated;
}

/** Mark a skill as deprecated with a reason. Returns false if skill not found. */
export function deprecateSkill(skillId: string, reason: string): boolean {
  const existing = skillsById.get(skillId);
  if (!existing) return false;
  const updated: SkillArtifact = {
    ...existing,
    status: "deprecated",
    mutationReason: reason,
  };
  skillsById.set(skillId, updated);
  rebuildActiveIndex();
  registryDeps?.onSkillUpserted?.(updated);
  return true;
}

/** Retrieve a single skill by ID, or null if not found. */
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
  const updated: SkillArtifact = {
    ...skill,
    usageCount: skill.usageCount + 1,
    lastUsedAt: new Date().toISOString(),
  };
  skillsById.set(skillId, updated);
  registryDeps?.onSkillUsageRecorded?.(updated);
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
  const updated: SkillArtifact = {
    ...skill,
    successRate: Math.max(0, Math.min(1, newRate)),
  };
  skillsById.set(skillId, updated);
  registryDeps?.onSkillSuccessRateChanged?.(updated);
}

// ── Health metrics ────────────────────────────────────────

/**
 * Compute the overall skill health report for a company:
 * total/active counts, average success rate, worst performers.
 */
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

// ── Phase 6: skill lifecycle helpers ──────────────────────

/**
 * Return active skills that have not been used in the last `staleDays` days.
 * Skills with `lastUsedAt === null` count as unused if their `createdAt`
 * is older than the window.
 */
export function getUnusedSkills(
  companyId: string,
  staleDays = 30,
): SkillArtifact[] {
  const cutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const active = getAllSkills(companyId).filter((s) => s.status === "active");

  return active.filter((skill) => {
    const reference = skill.lastUsedAt ?? skill.createdAt;
    if (!reference) return false;
    const referenceMs = new Date(reference).getTime();
    if (Number.isNaN(referenceMs)) return false;
    return referenceMs < cutoffMs && skill.usageCount === 0;
  });
}

/**
 * Return active skills currently underperforming (successRate < threshold).
 * Sorted worst-first so the Skills Lead can focus.
 */
export function getUnderperformingSkills(
  companyId: string,
  threshold = 0.6,
): SkillArtifact[] {
  return getAllSkills(companyId)
    .filter((s) => s.status === "active" && s.successRate < threshold && s.usageCount > 0)
    .sort((a, b) => a.successRate - b.successRate);
}

// ── Seed + lifecycle ──────────────────────────────────────

export function isSeeded(): boolean {
  return seeded;
}

function markSeeded(): void {
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

/** Store a SkillMutation (proposed, testing, approved, etc.) in the in-memory store. */
export function storeMutation(mutation: SkillMutation): void {
  mutationsById.set(mutation.id, { ...mutation });
}

/** Retrieve a mutation by ID, or null if not found. */
export function getMutationById(id: string): SkillMutation | null {
  return mutationsById.get(id) ?? null;
}

/** Update a mutation's status and optional fields. Sets resolvedAt for terminal states. */
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

/** Get all mutations for a company, sorted newest first. */
export function getMutationsForCompany(companyId: string): SkillMutation[] {
  const results: SkillMutation[] = [];
  for (const m of mutationsById.values()) {
    if (m.companyId === companyId) results.push(m);
  }
  return results.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
}

/** Get mutations in "proposed" or "revision" status for a company. */
export function getPendingMutations(companyId: string): SkillMutation[] {
  return getMutationsForCompany(companyId).filter(
    (m) => m.status === "proposed" || m.status === "revision",
  );
}

/** Store a failure attribution record. */
export function storeAttribution(attribution: FailureAttribution): void {
  attributionsStore.push({ ...attribution });
}

/** Get all failure attributions linked to skills in this company (plus gap attributions). */
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
  // Notify API layer so it can embed the trigger asynchronously
  registryDeps?.onSkillActivated?.(newSkill);
  return newSkill;
}

// ── Seed from Markdown files ──────────────────────────────

interface ResourceTypeInfo {
  kind: SkillResource["kind"];
  contentType: string;
  encoding: SkillResource["encoding"];
}

const RESOURCE_TYPE_MAP: Record<string, ResourceTypeInfo> = {
  ".md":   { kind: "reference", contentType: "text/markdown", encoding: "utf8" },
  ".mdx":  { kind: "reference", contentType: "text/markdown", encoding: "utf8" },
  ".txt":  { kind: "reference", contentType: "text/plain", encoding: "utf8" },
  ".json": { kind: "reference", contentType: "application/json", encoding: "utf8" },
  ".yaml": { kind: "reference", contentType: "application/yaml", encoding: "utf8" },
  ".yml":  { kind: "reference", contentType: "application/yaml", encoding: "utf8" },
  ".js":   { kind: "script", contentType: "application/javascript", encoding: "utf8" },
  ".mjs":  { kind: "script", contentType: "application/javascript", encoding: "utf8" },
  ".ts":   { kind: "script", contentType: "application/typescript", encoding: "utf8" },
  ".sh":   { kind: "script", contentType: "application/x-shellscript", encoding: "utf8" },
  ".png":  { kind: "asset", contentType: "image/png", encoding: "base64" },
  ".jpg":  { kind: "asset", contentType: "image/jpeg", encoding: "base64" },
  ".jpeg": { kind: "asset", contentType: "image/jpeg", encoding: "base64" },
  ".svg":  { kind: "asset", contentType: "image/svg+xml", encoding: "utf8" },
  ".pdf":  { kind: "asset", contentType: "application/pdf", encoding: "base64" },
};

function resolveResourceType(filePath: string): ResourceTypeInfo {
  const ext = extname(filePath).toLowerCase();
  return RESOURCE_TYPE_MAP[ext] ?? { kind: "reference", contentType: "application/octet-stream", encoding: "base64" };
}

/**
 * Walk `<skillDir>/resources/` recursively and build the SkillResource[] array.
 * Returns empty array if the resources directory does not exist.
 */
function readSkillResources(skillDir: string): SkillResource[] {
  const resourcesDir = join(skillDir, "resources");
  if (!existsSync(resourcesDir)) return [];

  const out: SkillResource[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = resolveResourceType(abs);
      const raw = readFileSync(abs);
      const content = info.encoding === "base64" ? raw.toString("base64") : raw.toString("utf8");
      out.push({
        path: relative(skillDir, abs),
        kind: info.kind,
        contentType: info.contentType,
        content,
        encoding: info.encoding,
      });
    }
  };
  walk(resourcesDir);
  return out;
}

/**
 * Parse YAML-ish frontmatter from a skill Markdown file.
 * Returns { frontmatter, body }.
 */
function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
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

export interface SeedSkillsOptions {
  /** Override the directory to seed from. Defaults to `<repoRoot>/.arceus/skills-seed`. */
  skillsDir?: string;
  /**
   * Upsert behavior when a skill with the same name already exists:
   * - `"preserve"` (default): skip, keep existing metrics (usageCount, successRate).
   * - `"overwrite-content"`: replace content + resources + role, preserve metrics.
   */
  mode?: "preserve" | "overwrite-content";
}

export interface SeedSkillsResult {
  seeded: number;   // newly registered
  updated: number;  // existing skills whose content/resources were overwritten
  skipped: number;  // existing skills left alone
}

/**
 * Seed the registry from SKILL.md files under a source directory.
 *
 * For each `<slug>/SKILL.md`, parses frontmatter + body and attaches any files
 * found in `<slug>/resources/` as tier-3 `SkillResource[]`. Idempotent — safe to
 * call repeatedly. Pass `mode: "overwrite-content"` to pick up edits without
 * losing existing metrics.
 *
 * Returns the count of newly-seeded skills (for backward compatibility with
 * callers that test `count > 0`). Use `seedExistingSkillsDetailed` for a full
 * breakdown of `{ seeded, updated, skipped }`.
 */
export function seedExistingSkills(
  companyId: string,
  skillsDirOrOptions?: string | SeedSkillsOptions,
): number {
  return seedExistingSkillsDetailed(companyId, skillsDirOrOptions).seeded;
}

/**
 * Full-breakdown variant of `seedExistingSkills`. Same behavior, richer return
 * value so callers can tell whether existing skills were updated vs skipped.
 */
export function seedExistingSkillsDetailed(
  companyId: string,
  skillsDirOrOptions?: string | SeedSkillsOptions,
): SeedSkillsResult {
  const opts: SeedSkillsOptions = typeof skillsDirOrOptions === "string"
    ? { skillsDir: skillsDirOrOptions }
    : skillsDirOrOptions ?? {};
  const mode = opts.mode ?? "preserve";

  // Default source: `.arceus/skills-seed/` at the repo root (four parents up from
  // `packages/company-runtime/src/`). Callers can override for tests.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const fallbackNew = resolve(thisDir, "..", "..", "..", ".arceus", "skills-seed");
  const fallbackLegacy = resolve(thisDir, "..", "skills");
  const dir = opts.skillsDir
    ?? (existsSync(fallbackNew) ? fallbackNew : fallbackLegacy);

  if (!existsSync(dir)) {
    console.warn(`[SkillRegistry] Skills directory not found: ${dir}`);
    return { seeded: 0, updated: 0, skipped: 0 };
  }

  let seededCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, "utf8");
    const { frontmatter, body } = parseSkillFrontmatter(raw);

    const name = frontmatter.name || entry.name;
    const role = frontmatter.role || "developer";
    const resources = readSkillResources(skillDir);

    const existing = getSkillHistory(companyId, name);
    if (existing.length > 0) {
      if (mode === "overwrite-content") {
        const latest = existing[existing.length - 1];
        updateSkill(latest.id, {
          role,
          trigger: frontmatter.description || name,
          content: body,
          resources,
        });
        updatedCount++;
      } else {
        skippedCount++;
      }
      continue;
    }

    const skill: SkillArtifact = {
      id: `skill-${name}-v1`,
      companyId,
      name,
      role,
      version: 1,
      status: "active",
      trigger: frontmatter.description || name,
      content: body,
      resources,
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
    seededCount++;
  }

  // Only mark seeded if we actually registered skills. If count=0 (all files
  // failed to parse, or all were filtered out), leave the flag false so the
  // next lazy-seed call gets another chance.
  if (seededCount > 0) markSeeded();
  return { seeded: seededCount, updated: updatedCount, skipped: skippedCount };
}

// ── Registry hooks (progressive-disclosure design) ────────
//
// Skill matching at dispatch time is NO LONGER done inside the registry.
// The orchestrator owns tier-1 classification via an LLM call over a
// compact catalog (see apps/api/src/orchestrator.ts:buildSkillCatalog /
// classifyTaskSkills). This replaces the former embedding-cosine matcher
// and removes the race condition between seed + embed + first-match.
//
// Sync token-overlap `matchSkills` remains for offline use cases (tests,
// cold-boot diagnostics, tooling). It is NOT on the runtime hot path.
//
// `onSkillActivated` still fires so downstream systems (pattern-learner
// audit, telemetry) can react when new skills are activated at runtime.
export interface SkillRegistryDeps {
  /** Called synchronously after a skill is activated (approved by ATA).
   *  Intended for fire-and-forget async work — indexing, telemetry, etc. */
  onSkillActivated?: (skill: SkillArtifact) => void;
  /** Called after registerSkill / updateSkill / deprecateSkill. Fire-and-forget
   *  hook for DB write-through (Spec 23 Pass 3). NOT called by hydrateSkill. */
  onSkillUpserted?: (skill: SkillArtifact) => void;
  /** Called after recordSkillUsage. Fire-and-forget hook for DB write-through. */
  onSkillUsageRecorded?: (skill: SkillArtifact) => void;
  /** Called after updateSuccessRate. Fire-and-forget hook for DB write-through. */
  onSkillSuccessRateChanged?: (skill: SkillArtifact) => void;
}

let registryDeps: SkillRegistryDeps | null = null;

export function setSkillRegistryDeps(d: SkillRegistryDeps): void {
  registryDeps = d;
}

export function hasSkillRegistryDeps(): boolean {
  return registryDeps !== null;
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

/** Tokenize text into lowercase tokens >2 chars with stop words removed. */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  return new Set(tokens);
}
