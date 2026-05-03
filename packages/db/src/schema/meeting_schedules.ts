import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, bigint, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { meetings } from "./meetings.js";

/**
 * `public.meeting_schedules` — recurring meeting cadences per
 * company. The scheduler reads `enabled = true` rows where
 * `next_check_at <= now()` and decides whether to fire a meeting
 * based on `conditional_check_enabled` + `config`. Spec 31
 * Phase 7.A — replaces `snapshot.meetingSchedules`.
 */
export const meetingSchedules = pgTable(
  "meeting_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Spec 31 Phase 5: friendly id round-trip ("ms_<uuid>"). */
    friendlyId: text("friendly_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    intervalMs: bigint("interval_ms", { mode: "number" }).notNull(),
    participantAgentIds: uuid("participant_agent_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    facilitatorAgentId: uuid("facilitator_agent_id").references(() => agents.id, { onDelete: "set null" }),
    conditionalCheckEnabled: boolean("conditional_check_enabled").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastMeetingId: uuid("last_meeting_id").references(() => meetings.id, { onDelete: "set null" }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    skipCount: integer("skip_count").notNull().default(0),
    totalRuns: integer("total_runs").notNull().default(0),
    /** Per-schedule config blob — meeting type defines its shape. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("meeting_schedules_company_enabled_next_idx")
      .on(table.companyId, table.enabled, table.nextCheckAt)
      .where(sql`${table.enabled} = true`),
    index("meeting_schedules_company_type_idx").on(table.companyId, table.type)
  ],
);
