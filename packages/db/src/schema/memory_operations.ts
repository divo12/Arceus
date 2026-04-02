import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    bindingId: uuid("binding_id"),
    operationType: text("operation_type").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown>>(),
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    resultCount: integer("result_count"),
    latencyMs: integer("latency_ms"),
    costCents: integer("cost_cents"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    embeddingTokens: integer("embedding_tokens"),
    success: boolean("success").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("memory_ops_company_agent_idx").on(table.companyId, table.agentId),
    typeIdx: index("memory_ops_type_idx").on(table.operationType),
  }),
);
