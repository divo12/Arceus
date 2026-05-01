/**
 * pgvector backend — embedding upsert + observability.
 * Spec 34 v3 PR 7.
 */
import { getDb } from "@arceus/db";
import { memoryEmbeddings } from "@arceus/db/src/schema/memory_embeddings.js";
import { EMBEDDING_MODEL_VERSION } from "@arceus/db/src/constants/embedding.js";
import { observability } from "@arceus/contracts";

/**
 * Surface embed() failures to the inspector + activity_log + pino + OTel
 * instead of swallowing them. F-409 audit finding: rows land without
 * embeddings and become invisible to vector search; before this hook,
 * operators had no signal that re-embedding was needed.
 *
 * The error is still non-fatal — the memory row is preserved and search
 * falls back to metadata ranking, just as before. The observable change
 * is the trail.
 */
export function logEmbedFailure(where: string, agentId: string, err: unknown): void {
  observability.logEvent({
    event: "error",
    where: `hippocampus.embed.${where}`,
    message: `[hippocampus/${agentId}] embed failed: ${err instanceof Error ? err.message : String(err)}`,
    stack: err instanceof Error && err.stack ? err.stack : undefined,
    ts: Date.now(),
  });
}

/**
 * Upsert the embedding row for a memory unit. Inserts on first write,
 * overwrites on re-embed. Spec 31 PR #13c moved embeddings off
 * `memory_units.embedding` onto a dedicated `memory_embeddings` table
 * so this helper keeps the call sites readable.
 */
export async function upsertEmbedding(memoryId: string, embedding: number[]): Promise<void> {
  const db = getDb();
  await db
    .insert(memoryEmbeddings)
    .values({ memoryId, embedding, modelVersion: EMBEDDING_MODEL_VERSION })
    .onConflictDoUpdate({
      target: memoryEmbeddings.memoryId,
      set: { embedding, modelVersion: EMBEDDING_MODEL_VERSION },
    });
}

/**
 * Set or replace the embedding vector for an existing memory unit.
 * Spec 31 PR #13c — embeddings now live in their own table, so this
 * upserts the row instead of updating an inline column.
 */
export async function setMemoryEmbedding(memoryId: string, embedding: number[]): Promise<void> {
  await upsertEmbedding(memoryId, embedding);
}
