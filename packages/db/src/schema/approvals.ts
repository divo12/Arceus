import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByRole: text("requested_by_role"),
    title: text("title").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decision: text("decision"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: text("decided_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusCreatedIdx: index("approvals_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companyKindStatusIdx: index("approvals_company_kind_status_idx").on(
      table.companyId,
      table.kind,
      table.status,
    ),
    requestedByAgentIdx: index("approvals_requested_by_agent_idx").on(table.requestedByAgentId),
    statusCheck: check(
      "approvals_status_check",
      sql`${table.status} IN ('pending','approved','rejected','expired')`,
    ),
  }),
);
