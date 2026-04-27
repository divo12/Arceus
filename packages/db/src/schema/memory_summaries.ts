import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * `public.memory_summaries` — one row per agent. Holds the rolling
 * "what's the agent thinking about?" cache that's surfaced to LLM
 * prompts at beat start. Spec 31 Phase 7.A — replaces
 * `snapshot.memories`.
 *
 * PK = `agent_id` because there's exactly one summary per agent at a
 * time. Updates overwrite in place.
 */
export const memorySummaries = pgTable(
  "memory_summaries",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    currentFocus: text("current_focus").array().notNull().default(sql`ARRAY[]::text[]`),
    recentLearnings: text("recent_learnings").array().notNull().default(sql`ARRAY[]::text[]`),
    activePatterns: text("active_patterns").array().notNull().default(sql`ARRAY[]::text[]`),
    openBlockers: text("open_blockers").array().notNull().default(sql`ARRAY[]::text[]`),
    importantDecisions: text("important_decisions").array().notNull().default(sql`ARRAY[]::text[]`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId] }),
    companyIdx: index("memory_summaries_company_idx").on(table.companyId),
  }),
);
