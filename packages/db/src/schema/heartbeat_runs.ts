import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  real,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export type VerdictSignals = {
  taskTransitions?: { completed: number; blocked: number };
  previewProbe?: { ok: boolean; latencyMs?: number };
  testSignal?: { passed: number; failed: number; total: number };
  artifactCount?: number;
};

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),

    beatNumber: integer("beat_number").notNull(),
    trigger: text("trigger").notNull(),
    triggerDetail: jsonb("trigger_detail").$type<Record<string, unknown>>(),

    status: text("status").notNull().default("running"),
    cause: text("cause"),

    sessionId: text("session_id"),
    trustBand: text("trust_band").notNull().default("standard"),

    verdictScore: real("verdict_score"),
    verdictOutcome: text("verdict_outcome"),
    verdictSignals: jsonb("verdict_signals").$type<VerdictSignals>(),

    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    totalCostCents: integer("total_cost_cents").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),

    processPid: integer("process_pid"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),

    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, { onDelete: "set null" }),
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(table.companyId, table.agentId, table.startedAt),
    companyStatusIdx: index("heartbeat_runs_company_status_idx").on(table.companyId, table.status),
    companyBeatNumberIdx: index("heartbeat_runs_company_beat_number_idx").on(table.companyId, table.beatNumber),
    retryOfRunIdIdx: index("heartbeat_runs_retry_of_run_id_idx").on(table.retryOfRunId),
    strandedIdx: index("heartbeat_runs_stranded_idx")
      .on(table.status, table.startedAt)
      .where(sql`status = 'running'`),
    statusCheck: check(
      "heartbeat_runs_status_check",
      sql`${table.status} IN ('running','completed','failed','stranded')`,
    ),
    verdictOutcomeCheck: check(
      "heartbeat_runs_verdict_outcome_check",
      sql`${table.verdictOutcome} IN ('pass','fail') OR ${table.verdictOutcome} IS NULL`,
    ),
    trustBandCheck: check(
      "heartbeat_runs_trust_band_check",
      sql`${table.trustBand} IN ('probation','standard','senior')`,
    ),
  }),
);
