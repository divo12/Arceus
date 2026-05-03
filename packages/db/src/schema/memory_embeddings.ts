import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, customType } from "drizzle-orm/pg-core";
import { memoryUnits } from "./memory_units.js";

/**
 * pgvector custom type — fixed at 384 dimensions to match
 * `all-MiniLM-L6-v2`, the model the runtime embedder loads via
 * `@huggingface/transformers` in
 * `packages/hippocampus/src/backends/embedding.ts`.
 *
 * Decision recorded in spec 31 PR #13 §3 (commit 8c10cb7, 2026-04-27):
 * staying at 384 means PR #13b's backfill is a verbatim
 * `INSERT … SELECT m.embedding FROM hippocampus.memory_units` — no
 * Azure API calls, no re-embedding pass, runtime memory-write path
 * stays local at ~20 ms.
 *
 * Revisit if any of these trigger:
 *   - Search recall complaints from users
 *   - Cross-company semantic search becomes a feature
 *   - Global "find similar companies" view that benchmarks against
 *     general-purpose embeddings
 *
 * To upgrade later: drop the column, recreate at the new dim, re-embed
 * via the chosen provider. Same dual-write template as PR #13b.
 */
const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(384)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
});

export const memoryEmbeddings = pgTable("memory_embeddings", {
  memoryId: uuid("memory_id")
    .primaryKey()
    .references(() => memoryUnits.id, { onDelete: "cascade" }),
  embedding: vector384("embedding").notNull(),
  modelVersion: text("model_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Note: the ivfflat / hnsw index on `embedding` must be created manually in the migration
// because drizzle-kit doesn't yet generate pgvector index types. The
// `vector_cosine_ops` operator class is dimension-agnostic, so the
// hint is unchanged from the original 1536 schema.
export { vector384 };
export const _memoryEmbeddingsIndexHint = sql`CREATE INDEX IF NOT EXISTS memory_embeddings_embedding_idx ON memory_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`;
