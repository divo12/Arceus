/**
 * Spec 23 Pass 3: DB write-through for the skill registry.
 * Spec 31 Phase 7.B.7 (B1): migrated off the legacy `skill_artifacts`
 * text-PK table to the canonical uuid-PK schema + a `skill_mutations`
 * sidecar that holds the audit log the legacy row used to inline.
 *
 * Persists skill EMA + usage counts to canonical `skill_artifacts` so
 * they survive process restart. Behind feature flag
 * `ARCEUS_SKILLS_DB_WRITETHROUGH=1`.
 *
 * Without the flag, this module is a no-op and the registry behaves
 * as pure in-memory (current behavior). When enabled:
 *   - on boot: load DB rows → hydrateSkill() (no callbacks fire), then
 *     seedExistingSkills() runs in "preserve" mode so DB rows win on
 *     collision.
 *   - at runtime: registerSkill / updateSkill / deprecateSkill /
 *     recordSkillUsage / updateSuccessRate fire callbacks that upsert
 *     the row.
 *
 * All writes are fire-and-forget: failures log a warning but never
 * throw back into the registry mutator (no behavioral change without
 * DB).
 *
 * ## Translation contract
 *
 * The `SkillArtifact` contract (49+ consumers across `packages/
 * company-runtime/src/skill-*.ts` and `apps/api/src/skills/*.ts`)
 * carries 5 fields the canonical `skill_artifacts` row dropped:
 * `testCases`, `mutatedFromId`, `mutatedBy`, `mutationReason`,
 * `approvedAt`. Those fields are the mutation history — they only
 * carry data on forked/emergent skills.
 *
 * Persistence boundary:
 *   - On insert: write current state to `skill_artifacts`. If any
 *     mutation field is non-null, also write a `skill_mutations` row
 *     pointing at the new skill.
 *   - On read: fetch the skill row + the latest mutation row (if any)
 *     and merge them back into the legacy `SkillArtifact` shape.
 *
 * Canonical-only fields (`slug`, `description`) are synthesised from
 * `name` when the in-memory skill object doesn't carry them.
 */

import type { SkillArtifact } from "@arceus/contracts";
import { hydrateSkill } from "@arceus/company-runtime";
import { isDatabaseConfigured, getDb } from "@arceus/db";
import { skillArtifacts, skillMutations } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import { and, desc, eq } from "drizzle-orm";

const FLAG_ENV = "ARCEUS_SKILLS_DB_WRITETHROUGH";

export function isSkillsDbWritethroughEnabled(): boolean {
  return process.env[FLAG_ENV] === "1" && isDatabaseConfigured();
}

// ── Mapping ───────────────────────────────────────────────

/**
 * Derive a canonical-required `slug` from the skill name. Lowercase,
 * non-alphanumerics → `_`, collapsed and trimmed. Slug uniqueness is
 * enforced per (company, slug) by the canonical schema; the
 * registry's existing dedup-by-name logic upstream means collisions
 * here are practically impossible.
 */
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "skill";
}

interface SkillRowValues {
  id: string;
  companyId: string;
  friendlyId: string;
  slug: string;
  name: string;
  role: string;
  version: number;
  status: string;
  triggerCondition: string;
  description: string;
  content: string;
  successRate: string; // numeric(5,4) carried as a string in drizzle
  usageCount: number;
  lastUsedAt: Date | null;
  deprecatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Translate the legacy contract shape into a canonical
 * `skill_artifacts` row. Mutation fields are extracted separately
 * (see `extractMutation`).
 */
function toSkillRow(skill: SkillArtifact): SkillRowValues {
  return {
    id: friendlyToUuid(skill.id),
    companyId: companiesRepo.toDbId(skill.companyId),
    friendlyId: skill.id,
    slug: deriveSlug(skill.name),
    name: skill.name,
    role: skill.role,
    version: skill.version,
    status: skill.status,
    triggerCondition: skill.trigger,
    // Canonical requires NOT NULL; the contract has no description
    // field. Stamp a synthetic value so writes succeed; tooling can
    // populate it later via a separate mutation.
    description: skill.name,
    content: skill.content,
    // numeric(5,4) — drizzle expects string-form for precise types.
    successRate: skill.successRate.toFixed(4),
    usageCount: skill.usageCount,
    lastUsedAt: skill.lastUsedAt ? new Date(skill.lastUsedAt) : null,
    deprecatedAt: null,
    createdAt: skill.createdAt ? new Date(skill.createdAt) : new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Pull mutation provenance off the contract object. Returns null
 * when none of the mutation fields are populated (a baseline / hand-
 * registered skill carries no history).
 */
function extractMutation(skill: SkillArtifact): {
  testCases: SkillArtifact["testCases"];
  mutatedFromId: string | null;
  mutatedBy: string | null;
  mutationReason: string | null;
  approvedAt: string | null;
} | null {
  const hasHistory =
    (skill.testCases && skill.testCases.length > 0) ||
    skill.mutatedFromId !== null ||
    skill.mutatedBy !== null ||
    skill.mutationReason !== null ||
    skill.approvedAt !== null;
  if (!hasHistory) return null;
  return {
    testCases: skill.testCases ?? [],
    mutatedFromId: skill.mutatedFromId ?? null,
    mutatedBy: skill.mutatedBy ?? null,
    mutationReason: skill.mutationReason ?? null,
    approvedAt: skill.approvedAt ?? null,
  };
}

type SkillRow = typeof skillArtifacts.$inferSelect;
type MutationRow = typeof skillMutations.$inferSelect;

/**
 * Reassemble a `SkillArtifact` from a canonical skill row + (optional)
 * its latest mutation row.
 */
function fromRows(row: SkillRow, mutation: MutationRow | null): SkillArtifact {
  return {
    id: row.friendlyId ?? row.id,
    companyId: row.companyId,
    name: row.name,
    role: row.role,
    version: row.version,
    status: row.status as SkillArtifact["status"],
    trigger: row.triggerCondition,
    content: row.content,
    testCases: ((mutation?.testCases as SkillArtifact["testCases"]) ?? []),
    successRate: Number(row.successRate),
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    mutatedFromId: mutation?.mutatedFromSkillId ?? null,
    mutatedBy: mutation?.mutatedByLabel ?? null,
    mutationReason: mutation?.mutationReason ?? null,
    createdAt: row.createdAt.toISOString(),
    approvedAt: mutation?.approvedAt ? mutation.approvedAt.toISOString() : null,
    resources: [],
  };
}

// ── Persistence ───────────────────────────────────────────

/** Upsert a skill row + its mutation history. Fire-and-forget. */
export function dbPersistSkill(skill: SkillArtifact): void {
  if (!isSkillsDbWritethroughEnabled()) return;
  const row = toSkillRow(skill);
  const mutation = extractMutation(skill);

  void (async () => {
    try {
      await getDb()
        .insert(skillArtifacts)
        .values(row)
        .onConflictDoUpdate({
          target: skillArtifacts.id,
          set: {
            slug: row.slug,
            name: row.name,
            role: row.role,
            version: row.version,
            status: row.status,
            triggerCondition: row.triggerCondition,
            description: row.description,
            content: row.content,
            successRate: row.successRate,
            usageCount: row.usageCount,
            lastUsedAt: row.lastUsedAt,
            deprecatedAt: row.deprecatedAt,
            updatedAt: row.updatedAt,
          },
        });

      if (mutation) {
        // One mutation row per skill update. The latest row wins on
        // read (ordered by created_at desc). For a simple flag-on,
        // flag-off lifecycle this is enough; once the contract is
        // reshaped (deferred), each forking event will write its own
        // row and we'll surface the full history.
        await getDb()
          .insert(skillMutations)
          .values({
            skillId: row.id,
            companyId: row.companyId,
            mutatedFromSkillId: mutation.mutatedFromId
              ? friendlyToUuid(mutation.mutatedFromId)
              : null,
            // `mutated_by_agent_id` is an agents FK; the legacy field
            // carries either an agent uuid or a synthetic actor name
            // (`pattern_learner`, `skill_mutator`). We can't tell
            // them apart cheaply, so always stamp the label and leave
            // the FK null. A follow-up can resolve real agents.
            mutatedByAgentId: null,
            mutatedByLabel: mutation.mutatedBy,
            mutationReason: mutation.mutationReason,
            testCases: (mutation.testCases as Array<Record<string, unknown>>),
            approvedAt: mutation.approvedAt
              ? new Date(mutation.approvedAt)
              : null,
          });
      }
    } catch (err: unknown) {
      console.warn(
        `[SkillDB] Failed to persist skill ${skill.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

/** Load all skills for a company, with their latest mutation row joined in. */
export async function dbLoadSkillsForCompany(companyId: string): Promise<SkillArtifact[]> {
  if (!isSkillsDbWritethroughEnabled()) return [];
  try {
    const dbCompanyId = companiesRepo.toDbId(companyId);
    const rows = await getDb()
      .select()
      .from(skillArtifacts)
      .where(eq(skillArtifacts.companyId, dbCompanyId));
    if (rows.length === 0) return [];

    // Pull each skill's latest mutation row in one query; in-memory
    // dedupe by skill_id keeps the join O(N + M) without a window
    // function.
    const mutationsRaw = await getDb()
      .select()
      .from(skillMutations)
      .where(eq(skillMutations.companyId, dbCompanyId))
      .orderBy(desc(skillMutations.createdAt));
    const latestBySkill = new Map<string, MutationRow>();
    for (const m of mutationsRaw) {
      if (!latestBySkill.has(m.skillId)) latestBySkill.set(m.skillId, m);
    }

    return rows.map((row) => fromRows(row, latestBySkill.get(row.id) ?? null));
  } catch (err) {
    console.warn(
      `[SkillDB] Failed to load skills for ${companyId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Hydrate the in-memory registry from DB. Call once at boot, BEFORE
 * `seedExistingSkills()`. Idempotent — calling twice just rewrites
 * the in-memory rows. No write-back fires (uses hydrateSkill).
 *
 * Returns the count loaded, or 0 if the flag is off / DB not
 * configured.
 */
export async function hydrateSkillRegistryFromDb(companyId: string): Promise<number> {
  if (!isSkillsDbWritethroughEnabled()) return 0;
  const skills = await dbLoadSkillsForCompany(companyId);
  for (const s of skills) hydrateSkill(s);
  if (skills.length > 0) {
    console.log(`[SkillDB] Hydrated ${skills.length} skills from DB for company ${companyId}`);
  }
  return skills.length;
}

// Suppress unused import warning when nothing else uses `and` here
void and;
