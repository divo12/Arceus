import { sql } from "drizzle-orm";
import { pgTable, uuid, text, real, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { tasks } from "./tasks.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const memoryUnits = pgTable(
  "memory_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    kind: text("kind"),
    content: text("content").notNull(),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    confidence: real("confidence").notNull().default(0.8),
    /**
     * Spec 31 PR #13c — dynamic-store decay knob. Search ranks by
     * `cosine_similarity × relevance_score × 0.5^(age / half_life)`;
     * GC soft-deletes rows whose decayed score drops below the
     * configured threshold. Defaults to 1.0 so legacy callers that
     * don't set it observe no decay.
     */
    relevanceScore: real("relevance_score").notNull().default(1.0),
    /**
     * Spec 05a delegation-memory grouping key — typically
     * `company:<id>:agent:<id>` or `task:<id>` for shared scopes.
     * Empty string means "no container scope" (the common case for
     * agent-private memories). Kept text rather than a structured
     * type so future container schemas don't require a migration.
     */
    container: text("container").notNull().default(""),
    /** Soft-delete tombstone — every read filters `IS NULL`. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** Audit trail for the soft-delete: 'expired', 'relevance_decay',
     *  'stale_prune', or operator-supplied. Empty when alive. */
    deleteReason: text("delete_reason").notNull().default(""),
    /** Optimistic-lock counter — bumped on update() so concurrent
     *  edits surface via the `version` mismatch rather than
     *  silently overwriting. */
    version: integer("version").notNull().default(1),
    sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
    sourceBeatId: uuid("source_beat_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    /**
     * Spec 31 PR #13a — bridge column for the hippocampus → public
     * memory_units cutover. Holds the original TEXT id from the legacy
     * `hippocampus.memory_units` row so PR #13b's batched backfill can
     * dedupe by `legacy_id` and PR #13d (post-soak) can DROP COLUMN.
     * Nullable because rows born in `public.memory_units` post-cutover
     * have no legacy origin.
     */
    legacyId: text("legacy_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentTypeCreatedIdx: index("memory_units_agent_type_created_idx").on(
      table.agentId,
      table.type,
      table.createdAt,
    ),
    /**
     * Spec 31 PR #13c — partial index excluding tombstones.
     * Every hot read filters `deleted_at IS NULL`, so the index stays
     * tight and matches the legacy `idx_memory_agent_type` shape so
     * plans don't regress on flip.
     */
    agentTypeLiveIdx: index("memory_units_agent_type_live_idx")
      .on(table.agentId, table.type)
      .where(sql`${table.deletedAt} IS NULL`),
    /** GC path: find expired temporal facts efficiently. */
    expiresLiveIdx: index("memory_units_expires_live_idx")
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    dynamicExpiresIdx: index("memory_units_dynamic_expires_idx")
      .on(table.agentId, table.expiresAt)
      .where(sql`type = 'dynamic'`),
    companyCreatedIdx: index("memory_units_company_created_idx").on(table.companyId, table.createdAt),
    sourceTaskIdx: index("memory_units_source_task_idx").on(table.sourceTaskId),
    sourceBeatIdx: index("memory_units_source_beat_idx").on(table.sourceBeatId),
    /**
     * Unique partial index on `legacy_id` enforces PR #13b's invariant
     * "one new row per legacy row" — re-running the backfill skips
     * rows already migrated via `WHERE NOT EXISTS (legacy_id)` rather
     * than producing duplicates. NULLs (post-cutover rows) are excluded
     * so the index doesn't bloat with non-bridge entries.
     */
    legacyIdIdx: uniqueIndex("memory_units_legacy_id_idx")
      .on(table.legacyId)
      .where(sql`${table.legacyId} IS NOT NULL`),
    typeCheck: check(
      "memory_units_type_check",
      sql`${table.type} IN ('static','dynamic','procedural','priming','delegation')`,
    ),
  }),
);
