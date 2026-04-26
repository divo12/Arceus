import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { meetingStatusSchema, meetingTypeSchema } from "@arceus/contracts";
import { companies } from "./companies.js";
import { sprints } from "./sprints.js";

/**
 * Build a SQL `IN ('a','b',...)` literal from a Zod enum's `.options`.
 * Single source of truth — adding a value to the contracts enum
 * automatically widens the DB CHECK constraint on the next migration.
 * `sql.raw` inlines the values as literals (CHECK constraints reject
 * placeholders); single-quote escape is defence in depth.
 */
const inLiteral = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "));

// Spec 31 Phase 4D: union of legacy schema kinds and contracts.meetingTypeSchema.
// Legacy values are kept so existing rows + writers keep working through the
// dual-write bridge; new writers must use a value from `meetingTypeSchema`.
const LEGACY_MEETING_KINDS = ["sprint_planning", "retro", "decision", "ad_hoc", "in_progress", "cancelled"] as const;
const ALL_MEETING_KINDS = [
  ...meetingTypeSchema.options,
  ...LEGACY_MEETING_KINDS.filter((k) => !meetingTypeSchema.options.includes(k as never)),
] as const;
const ALL_MEETING_STATUSES = [
  ...meetingStatusSchema.options,
  ...(["in_progress", "cancelled"] as const).filter((s) => !meetingStatusSchema.options.includes(s as never)),
] as const;

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sprintId: uuid("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    // Spec 31 Phase 4D: friendly id carrier; matches tasks/companies/sprints.
    friendlyId: text("friendly_id"),
    // Spec 31 Phase 4D: contracts.Meeting nests deeply — facilitatorAgentId,
    // participantAgentIds[], contributions[], synthesis, resolutions, brief,
    // healthSnapshot. All flow through `body jsonb` rather than getting
    // their own columns; we only surface what the route layer queries on.
    body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
    facilitatorAgentId: text("facilitator_agent_id"),
    scheduleId: text("schedule_id"),
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
    friendlyIdIdx: uniqueIndex("meetings_friendly_id_idx").on(table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    kindCheck: check("meetings_kind_check", sql`${table.kind} IN (${inLiteral(ALL_MEETING_KINDS)})`),
    statusCheck: check("meetings_status_check", sql`${table.status} IN (${inLiteral(ALL_MEETING_STATUSES)})`),
  }),
);
