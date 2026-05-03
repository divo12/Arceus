import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, numeric, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const skillArtifacts = pgTable(
  "skill_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Spec 31 Phase 5: friendly id round-trip carrier ("sk_orchestrate_meeting").
    // Distinct from slug — slug is a human-namespacing convention scoped to
    // a company, friendlyId is the global string the runtime registry uses.
    friendlyId: text("friendly_id"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"),
    triggerCondition: text("trigger_condition").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    successRate: numeric("success_rate", { precision: 5, scale: 4 }).notNull().default("0.5000"),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_artifacts_company_slug_idx").on(table.companyId, table.slug),
    uniqueIndex("skill_artifacts_friendly_id_idx").on(table.companyId, table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    index("skill_artifacts_company_role_status_idx").on(
      table.companyId,
      table.role,
      table.status,
    ),
    index("skill_artifacts_company_active_success_idx")
      .on(table.companyId, table.successRate)
      .where(sql`status = 'active'`),
    index("skill_artifacts_name_search_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    check(
      "skill_artifacts_status_check",
      sql`${table.status} IN ('draft','active','deprecated')`,
    )
  ],
);
