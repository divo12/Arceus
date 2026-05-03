import { and, asc, eq, sql } from "drizzle-orm";
import { skillEvolveJobs } from "../schema/skill_evolve_jobs.js";
import type { DbClient } from "./_helpers.js";

export type SkillEvolveJob = typeof skillEvolveJobs.$inferSelect;
export type NewSkillEvolveJob = typeof skillEvolveJobs.$inferInsert;

export async function enqueueJob(
  db: DbClient,
  data: NewSkillEvolveJob,
): Promise<SkillEvolveJob> {
  const [row] = await db.insert(skillEvolveJobs).values(data).returning();
  return row;
}

/** Lease one pending job atomically. Multiple workers calling in parallel collapse to one winner per row. */
export async function leaseOne(
  db: DbClient,
  workerId: string,
  maxAttempts = 3,
): Promise<SkillEvolveJob | null> {
  const rows = await db.execute(sql`
    UPDATE skill_evolve_jobs
       SET status = 'claimed',
           claimed_by = ${workerId},
           claimed_at = now(),
           attempts = attempts + 1
     WHERE id = (
       SELECT id FROM skill_evolve_jobs
        WHERE status = 'pending'
          AND attempts < ${maxAttempts}
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
   RETURNING *
  `) as unknown as SkillEvolveJob[];
  return rows[0] ?? null;
}

export async function completeJob(
  db: DbClient,
  id: string,
  result: Record<string, unknown>,
): Promise<SkillEvolveJob | null> {
  const [row] = await db
    .update(skillEvolveJobs)
    .set({ status: "done", result, completedAt: new Date() })
    .where(eq(skillEvolveJobs.id, id))
    .returning();
  return row ?? null;
}

export async function failJob(
  db: DbClient,
  id: string,
  error: Record<string, unknown>,
): Promise<SkillEvolveJob | null> {
  const [row] = await db
    .update(skillEvolveJobs)
    .set({ status: "failed", result: error, completedAt: new Date() })
    .where(eq(skillEvolveJobs.id, id))
    .returning();
  return row ?? null;
}

export async function listJobsByCompany(
  db: DbClient,
  companyId: string,
  status?: string,
): Promise<SkillEvolveJob[]> {
  const conditions = [eq(skillEvolveJobs.companyId, companyId)];
  if (status) conditions.push(eq(skillEvolveJobs.status, status));
  return db
    .select()
    .from(skillEvolveJobs)
    .where(and(...conditions))
    .orderBy(asc(skillEvolveJobs.createdAt));
}
