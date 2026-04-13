import "./load-env";
import { boolean, doublePrecision, integer, jsonb, pgTable, real, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";

/**
 * memory_units — Core storage for agent memories with vector embeddings.
 * Uses Drizzle's native vector(384) column for all-MiniLM-L6-v2 embeddings.
 */
export const memoryUnitsTable = pgTable("memory_units", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 384 }),
  memoryType: text("memory_type").notNull().default("dynamic"),
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
export const habitsTable = pgTable("habits", {
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
export const primingStateTable = pgTable("priming_state", {
  agentId: text("agent_id").primaryKey(),
  companyId: text("company_id").notNull(),
  confidence: doublePrecision("confidence").notNull().default(0.5),
  caution: doublePrecision("caution").notNull().default(0.5),
  morale: doublePrecision("morale").notNull().default(0.7),
  recentEvents: jsonb("recent_events").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
