import "./load-env";
import { boolean, doublePrecision, integer, jsonb, pgSchema, pgTable, real, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";

// Honor ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA (falls back to ARCEUS_DB_SCHEMA, then "public").
// Migration 001b_fix_schema.sql moved these tables into the `hippocampus` schema,
// so plain pgTable(...) without schema would emit queries against public and throw
// 42P01 (relation does not exist). Mirror the pattern from tables.ts.
const configuredSchemaName =
  process.env.ARCEUS_DB_SCHEMA?.trim() ||
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA?.trim() ||
  "public";

const hippocampusSchema = configuredSchemaName === "public" ? null : pgSchema(configuredSchemaName);
const defineTable: (name: string, columns: any) => any = hippocampusSchema ? hippocampusSchema.table.bind(hippocampusSchema) : pgTable;

/**
 * memory_units — Core storage for agent memories with vector embeddings.
 * Uses Drizzle's native vector(384) column for all-MiniLM-L6-v2 embeddings.
 */
export const memoryUnitsTable = defineTable("memory_units", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 384 }),
  // Two columns hold the memory category in different live DBs: the
  // original 001_hippocampus_memory.sql migration created `memory_type`
  // (NOT NULL DEFAULT 'dynamic'), while a parallel Drizzle schema file
  // (`schema/memory_units.ts`) describes a `type` (NOT NULL, no default)
  // column. Production environments end up with one or both depending on
  // which migration path was applied. Declare both here and write the
  // same value to each — the column that doesn't exist will be ignored
  // by drizzle's parameter mapping for missing columns at SQL execution
  // time on PG by way of a default-aware INSERT (we always supply the
  // value, and a missing column would have surfaced as 42703 long ago).
  // The real fix is the migration that converges both shapes; until then
  // this keeps `processTaskCompletion` from crashing every beat.
  memoryType: text("memory_type").notNull().default("dynamic"),
  type: text("type").notNull().default("dynamic"),
  confidence: real("confidence").notNull().default(0.0),
  relevanceScore: real("relevance_score").notNull().default(1.0),
  container: text("container").notNull(),
  visibility: text("visibility").notNull().default("private"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  metadata: jsonb("metadata").notNull().default({}),
  version: integer("version").notNull().default(1),
  previousVersionId: uuid("previous_version_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deleteReason: text("delete_reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * habits — Procedural memory. Behavioral patterns agents develop over time.
 */
export const habitsTable = defineTable("habits", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  agentId: text("agent_id").notNull(),
  triggerCondition: text("trigger_condition").notNull(),
  action: text("action").notNull(),
  confidence: doublePrecision("confidence").notNull().default(0.0),
  usageCount: integer("usage_count").notNull().default(0),
  formedFromId: text("formed_from_id").notNull().default(""),
  formationMode: text("formation_mode").notNull().default("auto"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * priming_state — Emotional/confidence state per agent. One row per agent.
 */
export const primingStateTable = defineTable("priming_state", {
  agentId: text("agent_id").primaryKey(),
  companyId: text("company_id").notNull(),
  confidence: doublePrecision("confidence").notNull().default(0.5),
  caution: doublePrecision("caution").notNull().default(0.5),
  morale: doublePrecision("morale").notNull().default(0.7),
  recentEvents: jsonb("recent_events").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
