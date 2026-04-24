import { pgTable, uuid, real, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { skillArtifacts } from "./skill_artifacts.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";

export const skillUsageEvents = pgTable(
  "skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => skillArtifacts.id, { onDelete: "cascade" }),
    beatId: uuid("beat_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    outcomeScore: real("outcome_score").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skillOccurredIdx: index("skill_usage_events_skill_occurred_idx").on(table.skillId, table.occurredAt),
    companyOccurredIdx: index("skill_usage_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    beatIdx: index("skill_usage_events_beat_idx").on(table.beatId),
    agentIdx: index("skill_usage_events_agent_idx").on(table.agentId),
  }),
);
