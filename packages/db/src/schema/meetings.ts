import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { routines } from "./routines.js";

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("scheduled"),
    title: text("title").notNull(),
    description: text("description"),
    agenda: jsonb("agenda").$type<
      Array<{
        topic: string;
        raisedByAgentId: string | null;
        type: "update" | "blocker" | "question" | "proposal";
        content: string;
      }>
    >(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    linkedRoutineId: uuid("linked_routine_id").references(() => routines.id, { onDelete: "set null" }),
    initiatedByAgentId: uuid("initiated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    initiatedByUserId: text("initiated_by_user_id"),
    meetingNotes: text("meeting_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("meetings_company_type_idx").on(table.companyId, table.type),
    companyStatusIdx: index("meetings_company_status_idx").on(table.companyId, table.status),
    companyScheduledIdx: index("meetings_company_scheduled_idx").on(table.companyId, table.scheduledAt),
  }),
);

export const meetingParticipants = pgTable(
  "meeting_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("attendee"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    contribution: jsonb("contribution").$type<{
      whatIDid: string | null;
      whatImDoing: string | null;
      blockers: string | null;
      learnings: string | null;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    meetingAgentUq: uniqueIndex("meeting_participants_meeting_agent_uq").on(table.meetingId, table.agentId),
    companyAgentIdx: index("meeting_participants_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

export const meetingEvents = pgTable(
  "meeting_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    meetingSeqIdx: index("meeting_events_meeting_seq_idx").on(table.meetingId, table.seq),
    companyKindIdx: index("meeting_events_company_kind_idx").on(table.companyId, table.kind),
  }),
);
