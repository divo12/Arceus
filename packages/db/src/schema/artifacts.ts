import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { artifactKindSchema } from "@arceus/contracts";
import { companies } from "./companies.js";
import { sprints } from "./sprints.js";
import { tasks } from "./tasks.js";
import { agents } from "./agents.js";

/**
 * Build a SQL `IN ('a','b',...)` literal from a Zod enum's `.options`.
 * `sql.raw` inlines the values as literals (CHECK constraints reject
 * placeholders); single-quote escape is defence in depth.
 */
const inLiteral = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "));

// Spec 31 Phase 4C: union of legacy schema kinds and contracts.artifactKindSchema.
// Legacy values stay valid through the dual-write bridge; the next phase
// drops them once every writer goes through the contracts-driven repo.
const LEGACY_ARTIFACT_KINDS = ["code", "design", "report", "campaign", "test", "spec"] as const;
const ALL_ARTIFACT_KINDS = [
  ...artifactKindSchema.options,
  ...LEGACY_ARTIFACT_KINDS.filter((k) => !artifactKindSchema.options.includes(k as never)),
] as const;

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sprintId: uuid("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    // Spec 31 Phase 4C: friendly id carrier; matches tasks/companies/sprints.
    friendlyId: text("friendly_id"),
    // Spec 31 Phase 4C: agent_role used to be NOT NULL — contracts.Artifact
    // doesn't carry role, the field is bookkeeping. Nullable during bridge.
    agentRole: text("agent_role"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    // Spec 31 Phase 4C: contracts.Artifact has summary + location +
    // contentType. The schema only had `content`. Both kept; `content` is
    // still produced by old writers and is now nullable so contract-shaped
    // inserts (which use `summary` instead) don't fail.
    content: text("content"),
    summary: text("summary"),
    location: text("location"),
    contentType: text("content_type"),
    fileReferences: jsonb("file_references").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("artifacts_company_task_idx").on(table.companyId, table.taskId),
    companySprintIdx: index("artifacts_company_sprint_idx").on(table.companyId, table.sprintId),
    companyKindIdx: index("artifacts_company_kind_idx").on(table.companyId, table.kind),
    companyCreatedIdx: index("artifacts_company_created_idx").on(table.companyId, table.createdAt),
    agentIdx: index("artifacts_agent_idx").on(table.agentId),
    friendlyIdIdx: index("artifacts_friendly_id_idx").on(table.friendlyId).where(sql`${table.friendlyId} IS NOT NULL`),
    titleSearchIdx: index("artifacts_title_search_idx").using("gin", sql`${table.title} gin_trgm_ops`),
    kindCheck: check("artifacts_kind_check", sql`${table.kind} IN (${inLiteral(ALL_ARTIFACT_KINDS)})`),
  }),
);
