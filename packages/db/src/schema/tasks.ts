import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { sprints } from "./sprints.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export type PlanStep = {
  stepNumber: number;
  description: string;
  status: "pending" | "done" | "skipped";
  note?: string;
};

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sprintId: uuid("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),

    taskNumber: integer("task_number").notNull(),
    identifier: text("identifier").notNull(),

    title: text("title").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("standard"),
    priority: text("priority").notNull().default("medium"),

    status: text("status").notNull().default("planned"),
    assignedRole: text("assigned_role"),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),

    // CAS columns — race-safe claim
    checkoutRunId: uuid("checkout_run_id").references((): AnyPgColumn => heartbeatRuns.id, { onDelete: "set null" }),
    executionRunId: uuid("execution_run_id").references((): AnyPgColumn => heartbeatRuns.id, { onDelete: "set null" }),
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),

    dependsOnTaskIds: uuid("depends_on_task_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),

    plan: jsonb("plan").$type<PlanStep[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    feedback: text("feedback"),

    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identifierUniqueIdx: uniqueIndex("tasks_identifier_idx").on(table.identifier),
    companyTaskNumberUniqueIdx: uniqueIndex("tasks_company_task_number_idx").on(table.companyId, table.taskNumber),

    companyStatusIdx: index("tasks_company_status_idx").on(table.companyId, table.status),
    companyAssignedRoleStatusIdx: index("tasks_company_role_status_idx").on(table.companyId, table.assignedRole, table.status),
    companySprintStatusIdx: index("tasks_company_sprint_status_idx").on(table.companyId, table.sprintId, table.status),
    parentIdx: index("tasks_company_parent_idx").on(table.companyId, table.parentTaskId),
    assignedAgentIdx: index("tasks_assigned_agent_idx").on(table.assignedAgentId),
    checkoutRunIdx: index("tasks_checkout_run_idx").on(table.checkoutRunId),
    executionRunIdx: index("tasks_execution_run_idx").on(table.executionRunId),

    // Trigram search on title — requires pg_trgm extension
    titleSearchIdx: index("tasks_title_search_idx").using("gin", sql`${table.title} gin_trgm_ops`),

    // Business invariant: at most one active claim per task
    activeClaimUniqueIdx: uniqueIndex("tasks_active_claim_idx")
      .on(table.id)
      .where(sql`checkout_run_id IS NOT NULL AND status IN ('claimed','in_progress')`),

    statusCheck: check(
      "tasks_status_check",
      sql`${table.status} IN ('planned','ready','claimed','in_progress','blocked','completed','verified','cancelled')`,
    ),
    priorityCheck: check(
      "tasks_priority_check",
      sql`${table.priority} IN ('low','medium','high','critical')`,
    ),
    kindCheck: check(
      "tasks_kind_check",
      sql`${table.kind} IN ('standard','technical_plan','acceptance_spec','implementation','board_handoff','service_validation','skill_apply_proposal')`,
    ),
  }),
);
