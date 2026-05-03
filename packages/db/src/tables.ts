/**
 * Spec 31 Phase 7 transitional shim — only `trustScoresTable` remains.
 * (Module-level `@deprecated` tag intentionally omitted: ESLint's
 * `no-deprecated` rule applies it to every export, and the remaining
 * `trustScoresTable` symbol is intentionally still in use until the
 * Spec 31b deferred migration replaces it with `roleTrust`.)
 *
 * After 7.B.7 (sprint_snapshots + skill_artifacts cutover), the only
 * legacy `*Table` declaration left is:
 *
 *   trustScoresTable → schema/role_trust.ts (roleTrust)
 *     Per-agent score (0–1) vs per-(company, role) band — different
 *     domain models. See plan `plans/specs/31b-...md` for the deferred
 *     migration. Until then the legacy text-PK table coexists with
 *     canonical `role_trust`.
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
 *   sprintSnapshotsTable  → workspace/manager.ts uses canonical
 *                           `sprintSnapshots`; the missing `snapshot_data`
 *                           column was re-added by migration 0018 (B.7).
 *   skillArtifactsTable   → skills/db-writethrough.ts uses canonical
 *                           `skillArtifacts` plus a new `skill_mutations`
 *                           sidecar (migration 0019). The legacy
 *                           contract still carries the inline mutation
 *                           fields; the writethrough splits them on
 *                           insert and reassembles on read (B.7).
 *
 * The physical `company_states` and `beat_records` tables are dropped by
 * migration `0017_phase7_drop_legacy_runtime_tables.sql`. Other retired
 * declarations are alternate type-views over physical tables that still
 * exist in canonical form — only the drizzle declaration is removed
 * when a consumer cuts over.
 */
import { jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Spec 31b: legacy per-agent trust score table. Coexists with canonical
 * `roleTrust` (`@arceus/db/src/schema/role_trust.js`) until the deferred
 * migration lands — the two have different domain models (per-agent
 * score 0–1 vs per-(company, role) band) so the cutover requires a data
 * remodel, not a rename. Do NOT mark `@deprecated` until the migration
 * is in flight; the lint rule fires on intentional in-use callsites.
 */
export const trustScoresTable = pgTable("trust_scores", {
  agentId: text("agent_id").primaryKey(),
  score: real("score").notNull().default(0.5),
  history: jsonb("history").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
