/**
 * pgvector backend — StaticMemoryStore.
 * Spec 34 v3 PR 7.
 *
 * Stores permanent facts with embedding-based vector similarity search.
 * Embeddings are generated on add/update and used for cosine distance ranking.
 */
import { eq, and, isNull, sql, desc, cosineDistance } from "drizzle-orm";
import { getDb } from "@arceus/db";
import { memoryUnits } from "@arceus/db/src/schema/memory_units.js";
import { memoryEmbeddings } from "@arceus/db/src/schema/memory_embeddings.js";
import type { MemoryUnit } from "@arceus/contracts";
import type { StaticMemoryStore } from "../../types.js";
import { canonicalRowToUnit, extractUuid } from "./canonical-codec.js";
import { BasePgVectorMemoryStore } from "./base-store.js";

export class PgVectorStaticStore
  extends BasePgVectorMemoryStore<"static">
  implements StaticMemoryStore
{
  protected readonly type = "static" as const;

  /**
   * Vector similarity search — returns top N most similar static memories.
   * Joins `memory_embeddings` for the vector; rows without an embedding
   * are excluded (the inner join filters them out, matching legacy
   * behaviour where rows whose embedding was NULL never ranked).
   */
  async searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    limit = 15,
  ): Promise<(MemoryUnit & { similarity: number })[]> {
    const db = getDb();
    const similarity = sql<number>`1 - (${cosineDistance(memoryEmbeddings.embedding, queryEmbedding)})`;

    const rows = await db
      .select({ memoryUnit: memoryUnits, similarity })
      .from(memoryUnits)
      .innerJoin(memoryEmbeddings, eq(memoryEmbeddings.memoryId, memoryUnits.id))
      .where(
        and(
          eq(memoryUnits.agentId, extractUuid(agentId)),
          eq(memoryUnits.type, "static"),
          isNull(memoryUnits.deletedAt),
        ),
      )
      .orderBy(desc(similarity))
      .limit(limit);

    return rows.map((row) => ({
      ...canonicalRowToUnit(row.memoryUnit),
      similarity: row.similarity,
    }));
  }
}
