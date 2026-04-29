import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { skillArtifacts } from "./skill_artifacts.js";

export const skillEvolveJobs = pgTable(
  "skill_evolve_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    targetSkillId: uuid("target_skill_id").references(() => skillArtifacts.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("skill_evolve_jobs_pending_lease_idx")
      .on(table.createdAt)
      .where(sql`status = 'pending'`),
    index("skill_evolve_jobs_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    index("skill_evolve_jobs_target_skill_idx").on(table.targetSkillId),
    check(
      "skill_evolve_jobs_trigger_check",
      sql`${table.trigger} IN ('ema_drop','cron','candidate','rollback')`,
    ),
    check(
      "skill_evolve_jobs_status_check",
      sql`${table.status} IN ('pending','claimed','running','done','failed')`,
    )
  ],
);
