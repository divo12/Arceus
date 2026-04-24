import { pgTable, uuid, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const primingStates = pgTable(
  "priming_states",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    recentOutcomes: jsonb("recent_outcomes").$type<Array<{ beatId: string; score: number }>>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId] }),
  }),
);
