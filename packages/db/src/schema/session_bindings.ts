import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const sessionBindings = pgTable(
  "session_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    beatId: uuid("beat_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    trustBand: text("trust_band").notNull(),
    allowedTools: text("allowed_tools").array().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    sessionIdUniqueIdx: uniqueIndex("session_bindings_session_id_idx").on(table.sessionId),
    beatIdx: index("session_bindings_beat_idx").on(table.beatId),
    companyIdx: index("session_bindings_company_idx").on(table.companyId),
  }),
);
