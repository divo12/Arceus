import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, roleDefinitions } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { ROLE_DEFINITION_SEEDS } from "./role-definition-seeds.js";

export function roleDefinitionService(db: Db) {
  return {
    list: async (companyId: string) => db
      .select()
      .from(roleDefinitions)
      .where(eq(roleDefinitions.companyId, companyId))
      .orderBy(asc(roleDefinitions.slug)),

    getBySlug: async (companyId: string, slug: string) => {
      const row = await db
        .select()
        .from(roleDefinitions)
        .where(and(
          eq(roleDefinitions.companyId, companyId),
          eq(roleDefinitions.slug, slug),
        ))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound(`Role "${slug}" not found`);
      return row;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(roleDefinitions)
        .where(eq(roleDefinitions.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Role definition not found");
      return row;
    },

    create: async (
      companyId: string,
      data: Omit<typeof roleDefinitions.$inferInsert, "companyId" | "isBuiltIn">,
    ) => {
      const [created] = await db
        .insert(roleDefinitions)
        .values({ ...data, companyId, isBuiltIn: false })
        .returning();
      return created!;
    },

    update: async (id: string, data: Partial<typeof roleDefinitions.$inferInsert>) => {
      const existing = await db
        .select()
        .from(roleDefinitions)
        .where(eq(roleDefinitions.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Role definition not found");

      if (existing.isBuiltIn && (data.slug !== undefined || data.isBuiltIn !== undefined)) {
        throw unprocessable("Cannot change slug or built-in status of a built-in role");
      }

      const [updated] = await db
        .update(roleDefinitions)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(roleDefinitions.id, id))
        .returning();
      return updated ?? null;
    },

    seedForCompany: async (companyId: string) => {
      const existing = await db
        .select({ slug: roleDefinitions.slug })
        .from(roleDefinitions)
        .where(eq(roleDefinitions.companyId, companyId));
      const existingSlugs = new Set(existing.map((row) => row.slug));

      const toInsert = ROLE_DEFINITION_SEEDS
        .filter((seed) => !existingSlugs.has(seed.slug))
        .map((seed) => ({
          ...seed,
          companyId,
          isBuiltIn: true,
        }));

      if (toInsert.length > 0) {
        await db.insert(roleDefinitions).values(toInsert);
      }
    },

    getForAgent: async (agentId: string) => {
      const agent = await db
        .select({
          role: agents.role,
          roleDefinitionId: agents.roleDefinitionId,
          companyId: agents.companyId,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent) return null;

      if (agent.roleDefinitionId) {
        const linked = await db
          .select()
          .from(roleDefinitions)
          .where(eq(roleDefinitions.id, agent.roleDefinitionId))
          .then((rows) => rows[0] ?? null);
        if (linked) return linked;
      }

      return db
        .select()
        .from(roleDefinitions)
        .where(and(
          eq(roleDefinitions.companyId, agent.companyId),
          eq(roleDefinitions.slug, agent.role),
        ))
        .then((rows) => rows[0] ?? null);
    },

    backfillAgentRoleLinks: async (companyId: string) => {
      const companyRoles = await db
        .select({ id: roleDefinitions.id, slug: roleDefinitions.slug })
        .from(roleDefinitions)
        .where(eq(roleDefinitions.companyId, companyId));
      const slugToId = new Map(companyRoles.map((row) => [row.slug, row.id]));

      const unlinkedAgents = await db
        .select({ id: agents.id, role: agents.role })
        .from(agents)
        .where(and(
          eq(agents.companyId, companyId),
          isNull(agents.roleDefinitionId),
        ));

      for (const agent of unlinkedAgents) {
        const roleDefinitionId = slugToId.get(agent.role);
        if (!roleDefinitionId) continue;
        await db
          .update(agents)
          .set({ roleDefinitionId, updatedAt: new Date() })
          .where(eq(agents.id, agent.id));
      }
    },
  };
}
