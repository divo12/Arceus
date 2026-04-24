import { desc, eq } from "drizzle-orm";
import { policyViolations } from "../schema/policy_violations.js";
import type { DbClient } from "./_helpers.js";

export type PolicyViolation = typeof policyViolations.$inferSelect;
export type NewPolicyViolation = typeof policyViolations.$inferInsert;

export async function recordViolation(
  db: DbClient,
  data: NewPolicyViolation,
): Promise<PolicyViolation> {
  const [row] = await db.insert(policyViolations).values(data).returning();
  return row;
}

export async function listViolationsByCompany(
  db: DbClient,
  companyId: string,
  limit = 50,
): Promise<PolicyViolation[]> {
  return db
    .select()
    .from(policyViolations)
    .where(eq(policyViolations.companyId, companyId))
    .orderBy(desc(policyViolations.createdAt))
    .limit(limit);
}
