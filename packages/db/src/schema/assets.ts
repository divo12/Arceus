import { pgTable, uuid, text, bigint, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("supabase"),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    originalFilename: text("original_filename"),
    namespace: text("namespace").notNull().default("misc"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("assets_company_object_key_idx").on(
      table.companyId,
      table.objectKey,
    ),
    index("assets_company_namespace_idx").on(table.companyId, table.namespace),
    index("assets_created_by_agent_idx").on(table.createdByAgentId)
  ],
);
