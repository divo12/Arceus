import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const policyViolations = pgTable(
  "policy_violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Spec 31 Phase 5: agent_id nullable so deny events recorded before agent
    // is resolved (e.g. pre-strategy onboarding, internal-system roles) still
    // land. agent_role carries the role string for those rows so the
    // dashboard can show "ceo violated rule X" without a join.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    agentRole: text("agent_role"),
    ruleId: text("rule_id").notNull(),
    tool: text("tool").notNull(),
    decision: text("decision").notNull(),
    severity: text("severity").notNull().default("medium"),
    detail: text("detail").notNull().default(""),
    beatId: uuid("beat_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("policy_violations_company_created_idx").on(table.companyId, table.createdAt),
    index("policy_violations_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    index("policy_violations_beat_idx").on(table.beatId),
    check(
      "policy_violations_severity_check",
      sql`${table.severity} IN ('low','medium','high','critical')`,
    )
  ],
);
