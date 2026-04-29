import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sprintStatusSchema } from "@arceus/contracts";
import { companies } from "./companies.js";

/**
 * Build a SQL `IN ('a','b',...)` literal from a Zod enum's `.options`.
 * `sql.raw` inlines the values as literals (CHECK constraints reject
 * placeholders); the single-quote escape is defence in depth — none of
 * our enum members contain quotes, but the helper stays safe.
 */
const inLiteral = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "));

// Spec 31 Phase 4B: legacy values from the original schema are kept through
// the dual-write bridge so existing rows + writers don't fail the constraint.
const LEGACY_SPRINT_STATUSES = ["planned", "active"] as const;
const ALL_SPRINT_STATUSES = [
  ...sprintStatusSchema.options,
  ...LEGACY_SPRINT_STATUSES.filter((s) => !sprintStatusSchema.options.includes(s as never)),
] as const;

export const sprints = pgTable(
  "sprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Spec 31 Phase 4B: friendly id round-trip carrier (matches tasks/companies)
    friendlyId: text("friendly_id"),
    // Spec 31 Phase 4B: sprint_number was NOT NULL but bootstrap doesn't always
    // know the next number — relaxed during bridge; backfill restores in Phase 7.
    sprintNumber: integer("sprint_number"),
    // Spec 31 Phase 4B: contracts.Sprint also carries title, summary,
    // strategyId, plannedByAgentId, and a nested reviewState.
    title: text("title"),
    summary: text("summary"),
    strategyId: text("strategy_id"),
    plannedByAgentId: text("planned_by_agent_id"),
    reviewState: jsonb("review_state").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("planning"),
    goal: text("goal"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sprints_company_number_idx")
      .on(table.companyId, table.sprintNumber)
      .where(sql`${table.sprintNumber} IS NOT NULL`),
    uniqueIndex("sprints_friendly_id_idx").on(table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    index("sprints_company_status_idx").on(table.companyId, table.status),
    check("sprints_status_check", sql`${table.status} IN (${inLiteral(ALL_SPRINT_STATUSES)})`)
  ],
);
