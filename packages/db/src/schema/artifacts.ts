import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { sprints } from "./sprints.js";
import { tasks } from "./tasks.js";
import { agents } from "./agents.js";

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sprintId: uuid("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    agentRole: text("agent_role").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    fileReferences: jsonb("file_references").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("artifacts_company_task_idx").on(table.companyId, table.taskId),
    companySprintIdx: index("artifacts_company_sprint_idx").on(table.companyId, table.sprintId),
    companyKindIdx: index("artifacts_company_kind_idx").on(table.companyId, table.kind),
    companyCreatedIdx: index("artifacts_company_created_idx").on(table.companyId, table.createdAt),
    agentIdx: index("artifacts_agent_idx").on(table.agentId),
    titleSearchIdx: index("artifacts_title_search_idx").using("gin", sql`${table.title} gin_trgm_ops`),
    kindCheck: check(
      "artifacts_kind_check",
      sql`${table.kind} IN ('code','plan','output','design','report','campaign','handoff','test','spec')`,
    ),
  }),
);
