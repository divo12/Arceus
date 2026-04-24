import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("active"),
    description: text("description"),
    goal: text("goal"),
    boardOwnerEmail: text("board_owner_email").notNull(),

    taskPrefix: text("task_prefix").notNull().default("ARC"),
    taskCounter: integer("task_counter").notNull().default(0),

    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    budgetResetAt: timestamp("budget_reset_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUniqueIdx: uniqueIndex("companies_slug_idx").on(table.slug),
    taskPrefixUniqueIdx: uniqueIndex("companies_task_prefix_idx").on(table.taskPrefix),
    statusIdx: index("companies_status_idx").on(table.status),
    statusCheck: check("companies_status_check", sql`${table.status} IN ('active','paused','archived')`),
  }),
);
