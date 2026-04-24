import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const sprints = pgTable(
  "sprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sprintNumber: integer("sprint_number").notNull(),
    status: text("status").notNull().default("planned"),
    goal: text("goal"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySprintNumberUniqueIdx: uniqueIndex("sprints_company_number_idx").on(table.companyId, table.sprintNumber),
    companyStatusIdx: index("sprints_company_status_idx").on(table.companyId, table.status),
    statusCheck: check(
      "sprints_status_check",
      sql`${table.status} IN ('planned','active','completed','cancelled')`,
    ),
  }),
);
