import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { meetings } from "./meetings.js";
import { agents } from "./agents.js";

export const meetingContributions = pgTable(
  "meeting_contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    contribution: text("contribution").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("meeting_contributions_meeting_agent_idx").on(
      table.meetingId,
      table.agentId,
    ),
    index("meeting_contributions_meeting_idx").on(table.meetingId)
  ],
);
