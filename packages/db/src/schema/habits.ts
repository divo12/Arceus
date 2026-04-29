import { sql } from "drizzle-orm";
import { pgTable, uuid, text, real, integer, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Canonical `public.habits` — procedural memory. Each row is a
 * trigger → action pattern an agent has learned. Spec 31 PR #13d
 * replaced the legacy `hippocampus.habits` text-PK table; FK columns
 * are uuid-typed and reference `companies` / `agents`.
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("habits_agent_active_idx")
      .on(table.agentId)
      .where(sql`${table.isActive} = true`),
    index("habits_company_idx").on(table.companyId),
    check(
      "habits_confidence_check",
      sql`${table.confidence} >= 0.0 AND ${table.confidence} <= 1.0`,
    ),
    check("habits_usage_count_check", sql`${table.usageCount} >= 0`),
    check(
      "habits_formation_mode_check",
      sql`${table.formationMode} IN ('auto','explicit')`,
    )
  ],
);
