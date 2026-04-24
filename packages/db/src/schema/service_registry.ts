import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const serviceRegistry = pgTable(
  "service_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    description: text("description").notNull(),
    allowedRoles: text("allowed_roles").array().notNull(),
    blastRadius: text("blast_radius").notNull().default("green"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    parameters: jsonb("parameters").$type<Array<Record<string, unknown>>>().notNull().default([]),
    source: text("source").notNull().default("system"),
    version: integer("version").notNull().default(1),
    addedBy: text("added_by").notNull().default("system"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyToolUniqueIdx: uniqueIndex("service_registry_company_tool_idx").on(table.companyId, table.toolName),
    companyToolIdx: index("service_registry_company_tool_lookup_idx").on(table.companyId, table.toolName),
    blastRadiusCheck: check(
      "service_registry_blast_radius_check",
      sql`${table.blastRadius} IN ('green','yellow','red')`,
    ),
  }),
);
