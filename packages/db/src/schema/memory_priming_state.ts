import {
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryPrimingState = pgTable("memory_priming_state", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  payload: jsonb("payload")
    .$type<{
      confidence: number;
      caution: number;
      morale: number;
      recentEvents: string[];
    }>()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
