import { sql } from "drizzle-orm";
import { pgTable, uuid, text, real, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { tasks } from "./tasks.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const memoryUnits = pgTable(
  "memory_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    kind: text("kind"),
    content: text("content").notNull(),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    confidence: real("confidence").notNull().default(0.8),
    sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
    sourceBeatId: uuid("source_beat_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentTypeCreatedIdx: index("memory_units_agent_type_created_idx").on(
      table.agentId,
      table.type,
      table.createdAt,
    ),
    dynamicExpiresIdx: index("memory_units_dynamic_expires_idx")
      .on(table.agentId, table.expiresAt)
      .where(sql`type = 'dynamic'`),
    companyCreatedIdx: index("memory_units_company_created_idx").on(table.companyId, table.createdAt),
    sourceTaskIdx: index("memory_units_source_task_idx").on(table.sourceTaskId),
    sourceBeatIdx: index("memory_units_source_beat_idx").on(table.sourceBeatId),
    typeCheck: check(
      "memory_units_type_check",
      sql`${table.type} IN ('static','dynamic','procedural','priming','delegation')`,
    ),
  }),
);
