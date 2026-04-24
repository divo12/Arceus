import { and, eq } from "drizzle-orm";
import { serviceRegistry } from "../schema/service_registry.js";
import type { DbClient } from "./_helpers.js";

export type ServiceEntry = typeof serviceRegistry.$inferSelect;
export type NewServiceEntry = typeof serviceRegistry.$inferInsert;

export async function registerTool(
  db: DbClient,
  data: NewServiceEntry,
): Promise<ServiceEntry> {
  const [row] = await db
    .insert(serviceRegistry)
    .values(data)
    .onConflictDoUpdate({
      target: [serviceRegistry.companyId, serviceRegistry.toolName],
      set: {
        description: data.description,
        allowedRoles: data.allowedRoles,
        blastRadius: data.blastRadius,
        requiresApproval: data.requiresApproval,
        parameters: data.parameters,
        version: data.version,
      },
    })
    .returning();
  return row;
}

export async function findTool(
  db: DbClient,
  companyId: string,
  toolName: string,
): Promise<ServiceEntry | null> {
  const [row] = await db
    .select()
    .from(serviceRegistry)
    .where(and(eq(serviceRegistry.companyId, companyId), eq(serviceRegistry.toolName, toolName)))
    .limit(1);
  return row ?? null;
}

export async function listToolsForCompany(
  db: DbClient,
  companyId: string,
): Promise<ServiceEntry[]> {
  return db.select().from(serviceRegistry).where(eq(serviceRegistry.companyId, companyId));
}
