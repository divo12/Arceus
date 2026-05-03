import { eq, sql } from "drizzle-orm";
import { memoryEmbeddings } from "../schema/memory_embeddings.js";
import type { DbClient } from "./_helpers.js";

export type MemoryEmbedding = typeof memoryEmbeddings.$inferSelect;

export async function upsertEmbedding(
  db: DbClient,
  memoryId: string,
  embedding: number[],
  modelVersion: string,
): Promise<void> {
  await db
    .insert(memoryEmbeddings)
    .values({ memoryId, embedding, modelVersion })
    .onConflictDoUpdate({
      target: memoryEmbeddings.memoryId,
      set: { embedding, modelVersion, createdAt: new Date() },
    });
}

/** Cosine-similarity nearest-neighbour lookup against pgvector. Returns memory_ids + distances. */
export async function nearestNeighbours(
  db: DbClient,
  query: number[],
  limit = 10,
): Promise<{ memoryId: string; distance: number }[]> {
  const vec = `[${query.join(",")}]`;
  const rows = await db.execute<{ memory_id: string; distance: string }>(sql`
    SELECT memory_id, embedding <=> ${vec}::vector AS distance
      FROM memory_embeddings
     ORDER BY embedding <=> ${vec}::vector
     LIMIT ${limit}
  `) as unknown as { memory_id: string; distance: string }[];
  return rows.map((r) => ({ memoryId: r.memory_id, distance: Number(r.distance) }));
}

export async function deleteEmbedding(db: DbClient, memoryId: string): Promise<void> {
  await db.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, memoryId));
}
