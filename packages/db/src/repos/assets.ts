import { eq } from "drizzle-orm";
import { assets } from "../schema/assets.js";
import type { DbClient } from "./_helpers.js";

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;

export async function registerAsset(db: DbClient, data: NewAsset): Promise<Asset> {
  const [row] = await db.insert(assets).values(data).returning();
  return row;
}

export async function findAssetById(db: DbClient, id: string): Promise<Asset | null> {
  const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  return row ?? null;
}

export async function listAssetsByCompany(
  db: DbClient,
  companyId: string,
  namespace?: string,
): Promise<Asset[]> {
  if (namespace) {
    return db
      .select()
      .from(assets)
      .where(eq(assets.companyId, companyId));
  }
  return db.select().from(assets).where(eq(assets.companyId, companyId));
}
