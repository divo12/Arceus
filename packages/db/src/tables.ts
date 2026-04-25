import "./load-env";
import { integer, jsonb, numeric, pgSchema, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";

const configuredSchemaName = process.env.ARCEUS_DB_SCHEMA?.trim() || process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA?.trim() || "public";
const arceusSchema = configuredSchemaName === "public" ? null : pgSchema(configuredSchemaName);

export const workspacesTable = arceusSchema ? arceusSchema.table("workspaces", {
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
}) : pgTable("workspaces", {
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

export const sprintSnapshotsTable = arceusSchema ? arceusSchema.table("sprint_snapshots", {
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
}) : pgTable("sprint_snapshots", {
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

export const artifactsTable = arceusSchema ? arceusSchema.table("artifacts", {
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
}) : pgTable("artifacts", {
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

export const companyStatesTable = arceusSchema ? arceusSchema.table("company_states", {
  companyId: text("company_id").primaryKey(),
  snapshotData: jsonb("snapshot_data").notNull(),
  eventLog: jsonb("event_log").notNull().default([]),
  snapshotVersion: integer("snapshot_version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}) : pgTable("company_states", {
  companyId: text("company_id").primaryKey(),
  snapshotData: jsonb("snapshot_data").notNull(),
  eventLog: jsonb("event_log").notNull().default([]),
  snapshotVersion: integer("snapshot_version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assetsTable = arceusSchema ? arceusSchema.table("assets", {
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
}) : pgTable("assets", {
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

export const auditEventsTable = arceusSchema ? arceusSchema.table("audit_events", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  sequence: integer("sequence").notNull(),
  category: text("category").notNull(),
  severity: text("severity").notNull().default("info"),
  eventType: text("event_type").notNull(),
  agentId: text("agent_id"),
  agentRole: text("agent_role"),
  summary: text("summary").notNull(),
  detail: jsonb("detail"),
  correlationId: text("correlation_id"),
  causationId: text("causation_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  beatId: text("beat_id"),
}) : pgTable("audit_events", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  sequence: integer("sequence").notNull(),
  category: text("category").notNull(),
  severity: text("severity").notNull().default("info"),
  eventType: text("event_type").notNull(),
  agentId: text("agent_id"),
  agentRole: text("agent_role"),
  summary: text("summary").notNull(),
  detail: jsonb("detail"),
  correlationId: text("correlation_id"),
  causationId: text("causation_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  beatId: text("beat_id"),
});

export const beatRecordsTable = arceusSchema ? arceusSchema.table("beat_records", {
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
}) : pgTable("beat_records", {
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

// ── Spec 13: Governance tables ──────────────────────────────

export const trustScoresTable = arceusSchema ? arceusSchema.table("trust_scores", {
  agentId: text("agent_id").primaryKey(),
  score: real("score").notNull().default(0.5),
  history: jsonb("history").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}) : pgTable("trust_scores", {
  agentId: text("agent_id").primaryKey(),
  score: real("score").notNull().default(0.5),
  history: jsonb("history").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const policyViolationsTable = arceusSchema ? arceusSchema.table("policy_violations", {
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
}) : pgTable("policy_violations", {
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

// ── Spec 14: Skill Evolution tables ───────────────────────

const skillArtifactColumns = {
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
};

export const skillArtifactsTable = arceusSchema
  ? arceusSchema.table("skill_artifacts", skillArtifactColumns)
  : pgTable("skill_artifacts", skillArtifactColumns);

export const workspaceStorageTables = {
  workspaces: workspacesTable,
  sprintSnapshots: sprintSnapshotsTable,
  artifacts: artifactsTable,
  companyStates: companyStatesTable,
  assets: assetsTable,
  auditEvents: auditEventsTable,
  beatRecords: beatRecordsTable,
  trustScores: trustScoresTable,
  policyViolations: policyViolationsTable,
  skillArtifacts: skillArtifactsTable,
};

export const arceusDatabaseSchemaName = configuredSchemaName;