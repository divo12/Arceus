/**
 * @deprecated Spec 31 Phase 7 transitional shim.
 *
 * These declarations describe the public-schema tables with text-typed
 * primary keys / FKs — the shape the runtime used before the spec 31
 * normalized schema (`./schema/*.ts`) replaced them. Postgres accepts
 * UUID-formatted strings into uuid columns, so reads/writes still
 * succeed against the canonical tables, but every export here has a
 * canonical replacement that consumers should adopt:
 *
 *   workspacesTable      → schema/workspaces.ts        (workspaces)
 *   sprintSnapshotsTable → schema/sprint_snapshots.ts  (sprintSnapshots)
 *   artifactsTable       → schema/artifacts.ts         (artifacts)
 *   assetsTable          → schema/assets.ts            (assets)
 *   trustScoresTable     → schema/role_trust.ts        (roleTrust)
 *   policyViolationsTable→ schema/policy_violations.ts (policyViolations)
 *   skillArtifactsTable  → schema/skill_artifacts.ts   (skillArtifacts)
 *
 * `companyStatesTable` and `beatRecordsTable` have no canonical
 * replacement — they belong to the in-memory store + heartbeat-record
 * dual-write paths that get deleted as part of the broader Phase 7
 * `getSnapshot()` rewrite. Their declarations stay until the
 * consumers (`persistence/store.ts`, `persistence/control-plane.ts`,
 * `persistence/company-state.ts`) are migrated.
 *
 * Spec 31 Phase 7 migration 0015 dropped the `hippocampus` schema, so
 * the legacy `arceusSchema` ternary that used to switch between
 * `hippocampus.<table>` and `public.<table>` is gone — every
 * declaration is a plain `pgTable("<name>", …)`.
 */
import { integer, jsonb, numeric, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

/** @deprecated Use `workspaces` from `@arceus/db/src/schema/workspaces.js`. */
export const workspacesTable = pgTable("workspaces", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  localPath: text("local_path"),
  status: text("status").notNull(),
  latestBundleKey: text("latest_bundle_key"),
  latestBundleSha256: text("latest_bundle_sha256"),
  latestBundleBytes: integer("latest_bundle_bytes"),
  currentSprintNumber: integer("current_sprint_number").notNull().default(0),
  currentGitRef: text("current_git_ref"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** @deprecated Use `sprintSnapshots` from `@arceus/db/src/schema/sprint_snapshots.js`. */
export const sprintSnapshotsTable = pgTable("sprint_snapshots", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  sprintNumber: integer("sprint_number").notNull(),
  gitTag: text("git_tag").notNull(),
  bundleKey: text("bundle_key"),
  bundleSha256: text("bundle_sha256"),
  bundleBytes: integer("bundle_bytes"),
  snapshotData: jsonb("snapshot_data").notNull(),
  fileManifest: jsonb("file_manifest").notNull().default([]),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** @deprecated Use `artifacts` from `@arceus/db/src/schema/artifacts.js`. */
export const artifactsTable = pgTable("artifacts", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  sprintId: text("sprint_id"),
  taskId: text("task_id"),
  agentRole: text("agent_role").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  fileReferences: jsonb("file_references").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * @deprecated No canonical replacement — the in-memory snapshot
 *   serialiser is slated for removal in the Phase 7 store rewrite.
 *   Persisted by `apps/api/src/persistence/company-state.ts`.
 */
export const companyStatesTable = pgTable("company_states", {
  companyId: text("company_id").primaryKey(),
  snapshotData: jsonb("snapshot_data").notNull(),
  eventLog: jsonb("event_log").notNull().default([]),
  snapshotVersion: integer("snapshot_version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** @deprecated Use `assets` from `@arceus/db/src/schema/assets.js`. */
export const assetsTable = pgTable("assets", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  provider: text("provider").notNull().default("supabase"),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  originalFilename: text("original_filename"),
  namespace: text("namespace").notNull(),
  createdByAgent: text("created_by_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * @deprecated No canonical replacement — the heartbeat-record table
 *   is replaced by `heartbeatRuns` from `@arceus/db/src/schema/heartbeat_runs.js`,
 *   but the consumer (`apps/api/src/persistence/control-plane.ts`)
 *   still writes the legacy shape until the Phase 7 store rewrite
 *   migrates it.
 */
export const beatRecordsTable = pgTable("beat_records", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  agentId: text("agent_id"),
  beatNumber: integer("beat_number").notNull(),
  trigger: jsonb("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  snapshotVersionRead: integer("snapshot_version_read"),
  snapshotVersionWritten: integer("snapshot_version_written"),
  phases: jsonb("phases").notNull().default({}),
  outcome: text("outcome"),
  totalTokens: integer("total_tokens").notNull().default(0),
  costCents: numeric("cost_cents", { precision: 12, scale: 4 }).notNull().default("0"),
  errorMessage: text("error_message"),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** @deprecated Use `roleTrust` from `@arceus/db/src/schema/role_trust.js`. */
export const trustScoresTable = pgTable("trust_scores", {
  agentId: text("agent_id").primaryKey(),
  score: real("score").notNull().default(0.5),
  history: jsonb("history").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** @deprecated Use `policyViolations` from `@arceus/db/src/schema/policy_violations.js`. */
export const policyViolationsTable = pgTable("policy_violations", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  agentId: text("agent_id").notNull(),
  ruleId: text("rule_id").notNull(),
  tool: text("tool").notNull(),
  decision: text("decision").notNull(),
  severity: text("severity").notNull().default("medium"),
  detail: text("detail").notNull().default(""),
  beatId: text("beat_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** @deprecated Use `skillArtifacts` from `@arceus/db/src/schema/skill_artifacts.js`. */
export const skillArtifactsTable = pgTable("skill_artifacts", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"),
  triggerCondition: text("trigger_condition").notNull(),
  content: text("content").notNull(),
  testCases: jsonb("test_cases").notNull().default([]),
  successRate: real("success_rate").notNull().default(0.5),
  usageCount: integer("usage_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  mutatedFromId: text("mutated_from_id"),
  mutatedBy: text("mutated_by"),
  mutationReason: text("mutation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});
