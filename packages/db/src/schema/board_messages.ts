import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { approvals } from "./approvals.js";

export const boardMessages = pgTable(
  "board_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    sender: text("sender").notNull(),
    content: text("content").notNull(),
    relatedTaskId: uuid("related_task_id").references(() => tasks.id, { onDelete: "set null" }),
    relatedApprovalId: uuid("related_approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("board_messages_company_created_idx").on(table.companyId, table.createdAt),
    companyDirectionCreatedIdx: index("board_messages_company_direction_created_idx").on(
      table.companyId,
      table.direction,
      table.createdAt,
    ),
    relatedTaskIdx: index("board_messages_related_task_idx").on(table.relatedTaskId),
    relatedApprovalIdx: index("board_messages_related_approval_idx").on(table.relatedApprovalId),
    directionCheck: check(
      "board_messages_direction_check",
      sql`${table.direction} IN ('inbound','outbound')`,
    ),
  }),
);
