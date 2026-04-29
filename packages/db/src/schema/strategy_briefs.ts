import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * `public.strategy_briefs` — CEO-authored strategy proposals. One
 * "active" row per company at any time; older rows persist as
 * history when a strategy is rejected and re-proposed. Spec 31
 * Phase 7.A — replaces `snapshot.strategy` from the in-memory store.
 */
export const strategyBriefs = pgTable(
  "strategy_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Spec 31 Phase 5: friendly id round-trip ("strategy_<uuid>"). */
    friendlyId: text("friendly_id"),
    title: text("title").notNull().default(""),
    summary: text("summary").notNull().default(""),
    firstRelease: text("first_release").notNull().default(""),
    scopeBoundary: text("scope_boundary").array().notNull().default(sql`ARRAY[]::text[]`),
    roleRationale: text("role_rationale").array().notNull().default(sql`ARRAY[]::text[]`),
    status: text("status").notNull().default("draft"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("strategy_briefs_company_status_idx").on(table.companyId, table.status),
    index("strategy_briefs_company_created_idx").on(table.companyId, table.createdAt),
    check(
      "strategy_briefs_status_check",
      sql`${table.status} IN ('draft','pending_board_approval','approved','rejected','superseded')`,
    )
  ],
);
