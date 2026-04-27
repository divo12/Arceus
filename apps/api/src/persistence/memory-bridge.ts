/**
 * Memory bridge — Spec 31 PR #13b.
 *
 * Online dual-write helper. Mirrors every write that lands in the
 * legacy `hippocampus.memory_units` table into the canonical
 * `public.memory_units` + `public.memory_embeddings` tables. Reads
 * still flow through the legacy backend; PR #13c flips the reads and
 * removes the legacy schema.
 *
 * The pure transforms live in `@arceus/db/src/bridges/memory-decode.ts`
 * — they're the single source of truth for the legacy → canonical
 * column mapping, reused by the one-shot `db:backfill-memory` script
 * so live and bulk paths produce byte-identical rows.
 */
import { eq } from "drizzle-orm";
import { getDb, type DbClient } from "@arceus/db";
import { memoryUnits } from "@arceus/db/src/schema/memory_units.js";
import { memoryEmbeddings } from "@arceus/db/src/schema/memory_embeddings.js";
import { tasks } from "@arceus/db/src/schema/tasks.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import {
  buildMemoryUnitInsert,
  LEGACY_EMBEDDING_MODEL,
  type LegacyMemoryRow,
  type LegacySourceType,
} from "@arceus/db/src/bridges/memory-decode.js";

export type { LegacyMemoryRow };
export {
  LEGACY_EMBEDDING_MODEL,
  decodeKind,
  decodeMemoryType,
  decodeTags,
} from "@arceus/db/src/bridges/memory-decode.js";

/**
 * Resolve a legacy `source_id` to the canonical `tasks.id` FK.
 * Returns `null` when the source isn't a task or the referenced task
 * no longer exists. The new schema declares the FK as
 * `ON DELETE SET NULL`, so the live path naturally clears stale refs;
 * the bridge mirrors that semantics on first write.
 */
export async function resolveSourceTaskId(
  db: DbClient,
  sourceType: LegacySourceType | null,
  sourceId: string | null,
): Promise<string | null> {
  if (sourceType !== "task" || !sourceId) return null;
  const candidate = friendlyToUuid(sourceId);
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, candidate))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Mirror a single legacy memory write into the canonical tables.
 *
 * **Idempotent.** The unique partial index on `memory_units.legacy_id`
 * (PR #13a, migration 0012) collapses re-runs into a no-op via
 * `ON CONFLICT DO NOTHING`. The online dual-write can fire after
 * every legacy insert without coordination, and the bulk backfill can
 * re-run safely on top of partial progress.
 *
 * Embeddings are upserted (not insert-or-skip) so a re-embedding from
 * a future model rollout overwrites the prior vector — `model_version`
 * carries the audit trail.
 *
 * Returns whether a new canonical row was inserted (false on conflict)
 * and the new row's id when one exists. The caller doesn't need to
 * branch on the result; it's surfaced for tests + the backfill
 * script's progress counters.
 */
export async function dualWriteMemoryUnit(
  legacy: LegacyMemoryRow,
  options: { db?: DbClient } = {},
): Promise<{ inserted: boolean; newId: string | null }> {
  const db = options.db ?? getDb();
  const sourceTaskId = await resolveSourceTaskId(db, legacy.sourceType, legacy.sourceId);
  const values = buildMemoryUnitInsert(legacy, sourceTaskId);

  const [row] = await db
    .insert(memoryUnits)
    .values(values)
    .onConflictDoNothing({ target: memoryUnits.legacyId })
    .returning({ id: memoryUnits.id });

  if (!row) return { inserted: false, newId: null };

  if (legacy.embedding && legacy.embedding.length > 0) {
    await db
      .insert(memoryEmbeddings)
      .values({
        memoryId: row.id,
        embedding: legacy.embedding,
        modelVersion: LEGACY_EMBEDDING_MODEL,
        createdAt: legacy.createdAt,
      })
      .onConflictDoUpdate({
        target: memoryEmbeddings.memoryId,
        set: {
          embedding: legacy.embedding,
          modelVersion: LEGACY_EMBEDDING_MODEL,
        },
      });
  }

  return { inserted: true, newId: row.id };
}
