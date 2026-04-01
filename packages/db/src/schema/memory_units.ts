import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryUnits = pgTable(
  "memory_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 384 }),
    memoryType: text("memory_type").notNull().$type<"static" | "dynamic" | "working">(),
    confidence: real("confidence").notNull().default(0.5),
    relevanceScore: real("relevance_score"),
    container: text("container").notNull(),
    visibility: text("visibility")
      .notNull()
      .default("private")
      .$type<"private" | "task_scoped" | "startup_shared" | "board_visible">(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    provenance: text("provenance"),
    version: integer("version").notNull().default(1),
    previousVersionId: uuid("previous_version_id"),
    promotionStatus: text("promotion_status")
      .default("pending")
      .$type<"pending" | "promoted" | "declined" | "expired">(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deleteReason: text("delete_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentTypeIdx: index("memory_units_agent_type_idx").on(table.agentId, table.memoryType),
    containerIdx: index("memory_units_container_idx").on(table.container),
    expiresIdx: index("memory_units_expires_idx").on(table.expiresAt),
    companyIdx: index("memory_units_company_idx").on(table.companyId),
  }),
);
