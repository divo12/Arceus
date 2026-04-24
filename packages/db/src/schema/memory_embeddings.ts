import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, customType } from "drizzle-orm/pg-core";
import { memoryUnits } from "./memory_units.js";

// pgvector custom type. Dimension parameter is fixed at 1536 (OpenAI ada-002 / text-embedding-3-small).
// If we move to a different embedding model, generate a new migration changing the column type.
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
});

export const memoryEmbeddings = pgTable("memory_embeddings", {
  memoryId: uuid("memory_id")
    .primaryKey()
    .references(() => memoryUnits.id, { onDelete: "cascade" }),
  embedding: vector1536("embedding").notNull(),
  modelVersion: text("model_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Note: the ivfflat / hnsw index on `embedding` must be created manually in the migration
// because drizzle-kit doesn't yet generate pgvector index types. See initial migration.
export { vector1536 };
export const _memoryEmbeddingsIndexHint = sql`CREATE INDEX IF NOT EXISTS memory_embeddings_embedding_idx ON memory_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`;
