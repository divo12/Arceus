import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { sprints } from "./sprints.js";

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sprintId: uuid("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("scheduled"),
    title: text("title").notNull(),
    summary: text("summary"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusScheduledIdx: index("meetings_company_status_scheduled_idx").on(
      table.companyId,
      table.status,
      table.scheduledAt,
    ),
    companyKindIdx: index("meetings_company_kind_idx").on(table.companyId, table.kind),
    sprintIdx: index("meetings_sprint_idx").on(table.sprintId),
    kindCheck: check(
      "meetings_kind_check",
      sql`${table.kind} IN ('daily_sync','sprint_planning','retro','decision','ad_hoc')`,
    ),
    statusCheck: check(
      "meetings_status_check",
      sql`${table.status} IN ('scheduled','in_progress','completed','cancelled')`,
    ),
  }),
);
