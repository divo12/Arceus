import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { chatMessageRoleSchema, chatMessageCardTypeSchema } from "@arceus/contracts";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { approvals } from "./approvals.js";

/** SQL `IN ('a','b',...)` literal driven by a Zod enum's `.options`. */
const inLiteral = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "));

export const boardMessages = pgTable(
  "board_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Spec 31 Phase 4E: friendly id round-trip carrier (matches every other domain).
    friendlyId: text("friendly_id"),
    // Spec 31 Phase 4E: original schema modelled an inbound/outbound external
    // channel — `direction` + `sender`. The runtime contract.ChatMessage
    // models internal board↔CEO chat with typed cards. Both coexist:
    //   - direction/sender stay nullable for legacy external-channel writers
    //   - role + card_type + card_data jsonb back the contract shape
    direction: text("direction"),
    sender: text("sender"),
    role: text("role"),
    sprintId: text("sprint_id"),
    agentId: text("agent_id"),
    cardType: text("card_type"),
    cardData: jsonb("card_data").$type<Record<string, unknown>>(),
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
    companyRoleCreatedIdx: index("board_messages_company_role_created_idx").on(
      table.companyId,
      table.role,
      table.createdAt,
    ),
    relatedTaskIdx: index("board_messages_related_task_idx").on(table.relatedTaskId),
    relatedApprovalIdx: index("board_messages_related_approval_idx").on(table.relatedApprovalId),
    friendlyIdIdx: uniqueIndex("board_messages_friendly_id_idx").on(table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    // Spec 31 Phase 4E: direction kept (legacy writers); role + card_type
    // gated through contracts enums via inLiteral so a new role/card type
    // in contracts widens the DB constraint on the next db:generate.
    directionCheck: check(
      "board_messages_direction_check",
      sql`${table.direction} IS NULL OR ${table.direction} IN ('inbound','outbound')`,
    ),
    roleCheck: check(
      "board_messages_role_check",
      sql`${table.role} IS NULL OR ${table.role} IN (${inLiteral(chatMessageRoleSchema.options)})`,
    ),
    cardTypeCheck: check(
      "board_messages_card_type_check",
      sql`${table.cardType} IS NULL OR ${table.cardType} IN (${inLiteral(chatMessageCardTypeSchema.options)})`,
    ),
  }),
);
