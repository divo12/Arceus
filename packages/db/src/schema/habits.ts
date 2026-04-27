import { sql } from "drizzle-orm";
import { pgTable, uuid, text, real, integer, boolean, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Canonical `public.habits` — procedural memory. Each row is a
 * trigger → action pattern an agent has learned. Spec 31 PR #13d
 * replaces the legacy `hippocampus.habits` text-PK table; FK columns
 * are now uuid-typed and reference `companies` / `agents`.
 *
 * `legacy_id` is the bridge column for the one-shot backfill, dropped
 * post-soak in PR #13e along with the `hippocampus` schema itself.
 */
export const habits = pgTable(
  "habits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    triggerCondition: text("trigger_condition").notNull(),
    action: text("action").notNull(),
    confidence: real("confidence").notNull().default(0.0),
    usageCount: integer("usage_count").notNull().default(0),
    formedFromId: text("formed_from_id").notNull().default(""),
    formationMode: text("formation_mode").notNull().default("auto"),
    isActive: boolean("is_active").notNull().default(true),
    legacyId: text("legacy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentActiveIdx: index("habits_agent_active_idx")
      .on(table.agentId)
      .where(sql`${table.isActive} = true`),
    companyIdx: index("habits_company_idx").on(table.companyId),
    legacyIdIdx: uniqueIndex("habits_legacy_id_idx")
      .on(table.legacyId)
      .where(sql`${table.legacyId} IS NOT NULL`),
    confidenceCheck: check(
      "habits_confidence_check",
      sql`${table.confidence} >= 0.0 AND ${table.confidence} <= 1.0`,
    ),
    usageCountCheck: check("habits_usage_count_check", sql`${table.usageCount} >= 0`),
    formationModeCheck: check(
      "habits_formation_mode_check",
      sql`${table.formationMode} IN ('auto','explicit')`,
    ),
  }),
);
