import { and, desc, eq, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { skillArtifacts } from "../schema/skill_artifacts.js";
import type { DbClient } from "./_helpers.js";

export type SkillArtifact = typeof skillArtifacts.$inferSelect;
export type NewSkillArtifact = typeof skillArtifacts.$inferInsert;

// ── ID boundary: friendly slug ↔ uuid (Phase 5) ──────────────────
const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Friendly skill ids (e.g. `sk_orchestrate_meeting`) are namespaced per
 * company via uuidv5. Two companies running the same seed skill therefore
 * resolve to two distinct DB rows — matches the per-company FK contract.
 */
export const toDbId = (companyDbId: string, friendly: string): string => {
  if (UUID_RE.test(friendly)) return friendly;
  return uuidv5(`${companyDbId}:${friendly}`, ARCEUS_UUID_NS);
};

export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

export async function createSkill(
  db: DbClient,
  data: NewSkillArtifact,
): Promise<SkillArtifact> {
  const [row] = await db.insert(skillArtifacts).values(data).returning();
  return row;
}

export async function findSkillById(db: DbClient, id: string): Promise<SkillArtifact | null> {
  const [row] = await db.select().from(skillArtifacts).where(eq(skillArtifacts.id, id)).limit(1);
  return row ?? null;
}

export async function findSkillBySlug(
  db: DbClient,
  companyId: string,
  slug: string,
): Promise<SkillArtifact | null> {
  const [row] = await db
    .select()
    .from(skillArtifacts)
    .where(and(eq(skillArtifacts.companyId, companyId), eq(skillArtifacts.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function listActiveSkillsForRole(
  db: DbClient,
  companyId: string,
  role: string,
): Promise<SkillArtifact[]> {
  return db
    .select()
    .from(skillArtifacts)
    .where(
      and(
        eq(skillArtifacts.companyId, companyId),
        eq(skillArtifacts.role, role),
        eq(skillArtifacts.status, "active"),
      ),
    )
    .orderBy(desc(skillArtifacts.successRate));
}

export async function updateSkill(
  db: DbClient,
  id: string,
  patch: Partial<NewSkillArtifact>,
): Promise<SkillArtifact | null> {
  const [row] = await db
    .update(skillArtifacts)
    .set(patch)
    .where(eq(skillArtifacts.id, id))
    .returning();
  return row ?? null;
}

export async function recordUsage(db: DbClient, id: string): Promise<void> {
  await db
    .update(skillArtifacts)
    .set({
      usageCount: sql`${skillArtifacts.usageCount} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(skillArtifacts.id, id));
}

// ── Hydration: contracts.SkillArtifact ↔ DB row (Phase 5) ────────

export interface UpsertSkillInput {
  friendlyId: string;
  companyId: string;
  companyDbId: string;
  name: string;
  slug: string;
  role: string;
  triggerCondition: string;
  description: string;
  content: string;
  successRate: number;
  usageCount: number;
  status: "draft" | "active" | "deprecated";
  version: number;
}

/**
 * Insert-or-replace by (company, friendly_id). Returns the DB uuid the
 * friendly slug resolves to under the per-company namespace.
 */
export async function upsertSkillArtifact(
  db: DbClient,
  input: UpsertSkillInput,
): Promise<SkillArtifact> {
  const dbId = toDbId(input.companyDbId, input.friendlyId);
  const values: NewSkillArtifact = {
    id: dbId,
    companyId: input.companyDbId,
    friendlyId: input.friendlyId,
    slug: input.slug,
    name: input.name,
    role: input.role,
    version: input.version,
    status: input.status,
    triggerCondition: input.triggerCondition,
    description: input.description,
    content: input.content,
    successRate: input.successRate.toFixed(4),
    usageCount: input.usageCount,
  };
  const [row] = await db
    .insert(skillArtifacts)
    .values(values)
    .onConflictDoUpdate({
      target: skillArtifacts.id,
      set: {
        friendlyId: values.friendlyId,
        slug: values.slug,
        name: values.name,
        role: values.role,
        version: values.version,
        status: values.status,
        triggerCondition: values.triggerCondition,
        description: values.description,
        content: values.content,
        successRate: values.successRate,
        usageCount: values.usageCount,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function deprecateSkill(db: DbClient, id: string): Promise<SkillArtifact | null> {
  const [row] = await db
    .update(skillArtifacts)
    .set({ status: "deprecated", deprecatedAt: new Date() })
    .where(eq(skillArtifacts.id, id))
    .returning();
  return row ?? null;
}
