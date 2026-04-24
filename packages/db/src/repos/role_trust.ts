import { and, desc, eq } from "drizzle-orm";
import { roleTrust } from "../schema/role_trust.js";
import { roleTrustEvents } from "../schema/role_trust_events.js";
import type { DbClient } from "./_helpers.js";

export type RoleTrust = typeof roleTrust.$inferSelect;
export type RoleTrustEvent = typeof roleTrustEvents.$inferSelect;
export type TrustBand = "probation" | "standard" | "senior";

export async function getTrust(
  db: DbClient,
  companyId: string,
  role: string,
): Promise<RoleTrust | null> {
  const [row] = await db
    .select()
    .from(roleTrust)
    .where(and(eq(roleTrust.companyId, companyId), eq(roleTrust.role, role)))
    .limit(1);
  return row ?? null;
}

export async function upsertTrust(
  db: DbClient,
  data: {
    companyId: string;
    role: string;
    band: TrustBand;
    rollingPassRate: string;
    beatsInBand: number;
    lastVerdictAt: Date;
  },
): Promise<RoleTrust> {
  const [row] = await db
    .insert(roleTrust)
    .values(data)
    .onConflictDoUpdate({
      target: [roleTrust.companyId, roleTrust.role],
      set: {
        band: data.band,
        rollingPassRate: data.rollingPassRate,
        beatsInBand: data.beatsInBand,
        lastVerdictAt: data.lastVerdictAt,
      },
    })
    .returning();
  return row;
}

export async function recordTransition(
  db: DbClient,
  data: {
    companyId: string;
    role: string;
    fromBand: TrustBand;
    toBand: TrustBand;
    reason: string;
    verdictWindow?: Array<{ beatId: string; score: number; outcome: string }>;
  },
): Promise<RoleTrustEvent> {
  const [row] = await db.insert(roleTrustEvents).values(data).returning();
  return row;
}

export async function listTrustHistory(
  db: DbClient,
  companyId: string,
  role: string,
  limit = 50,
): Promise<RoleTrustEvent[]> {
  return db
    .select()
    .from(roleTrustEvents)
    .where(and(eq(roleTrustEvents.companyId, companyId), eq(roleTrustEvents.role, role)))
    .orderBy(desc(roleTrustEvents.createdAt))
    .limit(limit);
}
