/**
 * @deprecated Spec 31 Phase 7 transitional shim.
 *
 * Two legacy `*Table` declarations remain. Both have schema gaps with
 * their canonical counterparts that aren't a clean swap:
 *
 *   sprintSnapshotsTable → schema/sprint_snapshots.ts (sprintSnapshots)
 *     Canonical schema dropped the `snapshot_data jsonb` column, but the
 *     `SprintSnapshot` contract (state.ts) still requires `snapshotData:
 *     CompanySnapshot`. Cutover requires either re-adding the column to
 *     canonical or dropping the field from the contract — tracked as the
 *     sprint-snapshot consolidation slice.
 *
 *   trustScoresTable → schema/role_trust.ts (roleTrust)
 *     Per-agent score (0–1) vs per-(company, role) band — different
 *     domain models. See plan 31b for the deferred migration.
 *
 *   skillArtifactsTable → schema/skill_artifacts.ts (skillArtifacts)
 *     Canonical added `slug`, `friendlyId`, `description`, `deprecatedAt`
 *     and dropped `testCases`, `mutatedFromId`, `mutatedBy`,
 *     `mutationReason`, `approvedAt`. The `SkillArtifact` contract still
 *     carries the dropped fields. Cutover blocked on contract reshape /
 *     mutation-history relocation.
 *
 * Spec 31 Phase 7.B retired these obsolete declarations:
 *   companyStatesTable    → snapshots are reassembled from canonical via
 *                           `buildSnapshotView` (7.C.d / 7.C.d-cp).
 *   beatRecordsTable      → heartbeat persistence in canonical
 *                           `heartbeat_runs` with a `triggerDetail._legacy`
 *                           sidecar (B.5.1).
 *   policyViolationsTable → control-plane CRUD + reset cascade now use
 *                           canonical `policyViolations` (B.5.3).
 *   workspacesTable       → workspace/manager.ts uses canonical
 *                           `workspaces` with friendly↔uuid translation
 *                           at the repo boundary (B.6).
 *   artifactsTable        → persistence/artifact-persistence.ts uses
 *                           canonical `artifacts` (B.6).
 *   assetsTable           → persistence/supabase-storage.ts uses canonical
 *                           `assets`; legacy `created_by_agent` text
 *                           field maps to canonical `created_by_agent_id`
 *                           uuid FK (B.6).
 * The physical `company_states` and `beat_records` tables are dropped by
 * migration `0017_phase7_drop_legacy_runtime_tables.sql`. The remaining
 * legacy declarations are alternate type-views over physical tables that
 * still exist in canonical form — only the drizzle declaration is
 * removed when a consumer cuts over.
 *
 * Spec 31 Phase 7 migration 0015 dropped the `hippocampus` schema, so
 * the legacy `arceusSchema` ternary that used to switch between
 * `hippocampus.<table>` and `public.<table>` is gone — every
 * declaration is a plain `pgTable("<name>", …)`.
 */
import { integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

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

/** @deprecated Use `roleTrust` from `@arceus/db/src/schema/role_trust.js`. */
export const trustScoresTable = pgTable("trust_scores", {
  agentId: text("agent_id").primaryKey(),
  score: real("score").notNull().default(0.5),
  history: jsonb("history").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
