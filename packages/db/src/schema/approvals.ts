import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { approvalStatusSchema } from "@arceus/contracts";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** SQL `IN ('a','b',...)` literal driven by a Zod enum's `.options`. */
const inLiteral = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "));

// Spec 31 Phase 4E: legacy 'expired' value kept until every consumer is
// contracts-shaped. Phase 7 drops it and the schema enum becomes
// approvalStatusSchema verbatim.
const LEGACY_APPROVAL_STATUSES = ["expired"] as const;
const ALL_APPROVAL_STATUSES = [
  ...approvalStatusSchema.options,
  ...LEGACY_APPROVAL_STATUSES.filter((s) => !approvalStatusSchema.options.includes(s as never)),
] as const;

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Spec 31 Phase 4E: friendly id round-trip carrier (matches every other domain)
    friendlyId: text("friendly_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByRole: text("requested_by_role"),
    title: text("title").notNull(),
    // Spec 31 Phase 4E: contracts.Approval has `description`, `meetingId`,
    // `agendaItemId`, `resolutionSummary` — all surfaced as columns so
    // routes can filter/display without a jsonb dive.
    description: text("description"),
    meetingId: text("meeting_id"),
    agendaItemId: text("agenda_item_id"),
    resolutionSummary: text("resolution_summary"),
    // Spec 31 Phase 4E: payload was NOT NULL — contracts.Approval doesn't
    // carry one, so contract-shaped writers default to {}; old writers
    // (kind-specific shapes) keep filling it. Both coexist.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
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
    friendlyIdIdx: uniqueIndex("approvals_friendly_id_idx").on(table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    statusCheck: check("approvals_status_check", sql`${table.status} IN (${inLiteral(ALL_APPROVAL_STATUSES)})`),
  }),
);
