/**
 * pgvector backend — DynamicMemoryStore.
 * Spec 34 v3 PR 7.
 *
 * Stores temporary facts with time-decay scoring:
 * decayed_score = cosine_similarity × relevance_score × 0.5^(age_days / 30).
 * GC expires temporal facts, prunes decayed relevance below 0.1, and removes
 * old low-confidence entries.
 */
import { eq, and, isNull, sql, desc, cosineDistance } from "drizzle-orm";
import { getDb } from "@arceus/db";
import { memoryUnits } from "@arceus/db/src/schema/memory_units.js";
import { memoryEmbeddings } from "@arceus/db/src/schema/memory_embeddings.js";
import type { MemoryUnit } from "@arceus/contracts";
import type { DynamicMemoryStore } from "../../types.js";
import {
  MEMORY_DECAY_HALF_LIFE_DAYS,
  RELEVANCE_DECAY_DELETE_THRESHOLD,
  SECONDS_PER_DAY,
} from "../pgvector-config.js";
import { canonicalRowToUnit, extractUuid } from "./canonical-codec.js";
import { BasePgVectorMemoryStore } from "./base-store.js";

// Pre-computed denominator for the decay-formula SQL — keeps the `30 *
// 86400` magic out of every query. Must stay a plain SQL literal because
// drizzle's `sql\`\`` template expects positional args, not parameters,
// inside POWER().
const DECAY_PERIOD_SECONDS = MEMORY_DECAY_HALF_LIFE_DAYS * SECONDS_PER_DAY;

export class PgVectorDynamicStore
  extends BasePgVectorMemoryStore<"dynamic">
  implements DynamicMemoryStore
{
  protected readonly type = "dynamic" as const;

  /**
   * Vector similarity search with decay scoring.
   * `decayed_score = cosine_similarity × relevance_score × 0.5^(age_days / half_life)`
   * Inner-joins `memory_embeddings`; rows without an embedding never
   * rank (matches legacy NULL-embedding behaviour).
   */
  async searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    limit = 15,
  ): Promise<(MemoryUnit & { similarity: number; decayedScore: number })[]> {
    const db = getDb();
    const similarity = sql<number>`1 - (${cosineDistance(memoryEmbeddings.embedding, queryEmbedding)})`;
    const decayedScore = sql<number>`
      (1 - (${cosineDistance(memoryEmbeddings.embedding, queryEmbedding)}))
      * ${memoryUnits.relevanceScore}
      * POWER(0.5, EXTRACT(EPOCH FROM (now() - ${memoryUnits.updatedAt})) / ${sql.raw(`${DECAY_PERIOD_SECONDS}.0`)})
    `;

    const rows = await db
      .select({ memoryUnit: memoryUnits, similarity, decayedScore })
      .from(memoryUnits)
      .innerJoin(memoryEmbeddings, eq(memoryEmbeddings.memoryId, memoryUnits.id))
      .where(
        and(
          eq(memoryUnits.agentId, extractUuid(agentId)),
          eq(memoryUnits.type, "dynamic"),
          isNull(memoryUnits.deletedAt),
        ),
      )
      .orderBy(desc(decayedScore))
      .limit(limit);

    return rows.map((row) => ({
      ...canonicalRowToUnit(row.memoryUnit),
      similarity: row.similarity,
      decayedScore: row.decayedScore,
    }));
  }

  async gc(companyId: string): Promise<number> {
    const db = getDb();
    const companyUuid = extractUuid(companyId);
    let deleted = 0;

    // 1. Expire temporal facts past their `expires_at`.
    const expired = await db
      .update(memoryUnits)
      .set({ deletedAt: new Date(), deleteReason: "expired" })
      .where(
        and(
          eq(memoryUnits.companyId, companyUuid),
          isNull(memoryUnits.deletedAt),
          sql`${memoryUnits.expiresAt} IS NOT NULL AND ${memoryUnits.expiresAt} < now()`,
        ),
      )
      .returning({ id: memoryUnits.id });
    deleted += expired.length;

    // 2. Soft-delete dynamic memories whose decayed relevance dropped
    //    below the configured threshold. Formula must match
    //    `searchByEmbedding` above so a row that ranks below the cut-
    //    off in search disappears from the corpus on the next GC pass.
    const decayed = await db.execute(sql`
      UPDATE memory_units
         SET deleted_at = now(), delete_reason = 'relevance_decay'
       WHERE company_id = ${companyUuid}
         AND type = 'dynamic'
         AND deleted_at IS NULL
         AND relevance_score * POWER(0.5, EXTRACT(EPOCH FROM (now() - updated_at)) / ${sql.raw(`${DECAY_PERIOD_SECONDS}.0`)}) < ${RELEVANCE_DECAY_DELETE_THRESHOLD}
    `);
    // drizzle's `db.execute(sql\`...\`)` return type varies by driver:
    //   postgres-js   → Array-like with `length`
    //   node-postgres → object with `rowCount`
    // Read whichever the runtime exposes.
    const decayedResult = decayed as { length?: number; rowCount?: number };
    deleted += Number(decayedResult.length ?? decayedResult.rowCount ?? 0);

    // 3. Prune stale: old, low-confidence dynamic facts.
    const pruned = await db
      .update(memoryUnits)
      .set({ deletedAt: new Date(), deleteReason: "stale_prune" })
      .where(
        and(
          eq(memoryUnits.companyId, companyUuid),
          eq(memoryUnits.type, "dynamic"),
          isNull(memoryUnits.deletedAt),
          sql`${memoryUnits.createdAt} < now() - interval '30 days'`,
          sql`${memoryUnits.confidence} < 0.3`,
        ),
      )
      .returning({ id: memoryUnits.id });
    deleted += pruned.length;

    return deleted;
  }
}
