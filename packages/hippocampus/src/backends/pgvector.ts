import { eq, and, inArray, isNull, sql, desc, cosineDistance } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "@arceus/db";
import { memoryUnits } from "@arceus/db/src/schema/memory_units.js";
import { memoryEmbeddings } from "@arceus/db/src/schema/memory_embeddings.js";
import { habits } from "@arceus/db/src/schema/habits.js";
import { primingStates } from "@arceus/db/src/schema/priming_states.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import { EMBEDDING_MODEL_VERSION } from "@arceus/db/src/constants/embedding.js";
import { decodePrimingState, encodePrimingState } from "@arceus/db/src/codecs/priming-state.js";
import type { MemoryUnit, Habit, PrimingState } from "@arceus/contracts";
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
function logEmbedFailure(where: string, agentId: string, err: unknown): void {
  observability.logEvent({
    event: "error",
    where: `hippocampus.embed.${where}`,
    message: `[hippocampus/${agentId}] embed failed: ${err instanceof Error ? err.message : String(err)}`,
    stack: err instanceof Error && err.stack ? err.stack : undefined,
    ts: Date.now(),
  });
}
import type { StaticMemoryStore, DynamicMemoryStore, ProceduralMemoryStore, PrimingStore } from "../types";
import { embed } from "./embedding.js";
import {
  MEMORY_DECAY_HALF_LIFE_DAYS,
  SECONDS_PER_DAY,
  RELEVANCE_DECAY_DELETE_THRESHOLD,
  MEMORY_LIST_DEFAULT_LIMIT,
} from "./pgvector-config.js";

// Pre-computed denominator for the decay-formula SQL — keeps the `30 *
// 86400` magic out of every query. Must stay a plain SQL literal because
// drizzle's `sql\`\`` template expects positional args, not parameters,
// inside POWER().
const DECAY_PERIOD_SECONDS = MEMORY_DECAY_HALF_LIFE_DAYS * SECONDS_PER_DAY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a canonical `public.memory_units` row to the domain
 * `MemoryUnit` type. Spec 31 PR #13c — the `kind` column carries what
 * legacy stored as `visibility`, and `source` is derived from the
 * presence of `source_task_id` (the canonical schema collapses
 * legacy's `source_type` enum into the FK relationship).
 */
function canonicalRowToUnit(row: typeof memoryUnits.$inferSelect): MemoryUnit {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    sourceTaskId: row.sourceTaskId,
    sourceArtifactId: null,
    type: row.type as MemoryUnit["type"],
    visibility: (row.kind ?? "private") as MemoryUnit["visibility"],
    // Domain `source` enum doesn't include the legacy "task" literal;
    // the canonical schema captures task linkage via `source_task_id`,
    // so when that FK is set we surface "task_completion" (the closest
    // semantic match) and fall back to "system" otherwise.
    source: row.sourceTaskId ? "task_completion" : "system",
    content: row.content,
    summary: row.content.slice(0, 200),
    confidence: row.confidence,
    tags: row.tags ?? [],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** Convert a canonical `habits` row to the domain Habit type. */
function canonicalHabitRowToHabit(row: typeof habits.$inferSelect): Habit {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    name: row.triggerCondition.slice(0, 60),
    description: row.action,
    trigger: row.triggerCondition,
    action: row.action,
    status: row.isActive ? "active" : "inactive",
    usageCount: row.usageCount,
    successRate: row.confidence,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Convert a canonical `priming_states` row to the domain PrimingState
 * type. Spec 31 PR #13d — legacy `confidence/caution/morale/recent_events`
 * are encoded inside the canonical `state` jsonb; we decode through
 * `decodePrimingState` so the codec is the single source of truth.
 */
function canonicalPrimingRowToState(row: typeof primingStates.$inferSelect): PrimingState {
  const decoded = decodePrimingState(row.state);
  return {
    id: `priming_${row.agentId}`,
    companyId: row.companyId,
    agentId: row.agentId,
    confidence: decoded.confidence,
    caution: decoded.caution,
    morale: decoded.morale,
    lastDisposition: "",
    recentEvents: decoded.recentEvents,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Extract the raw UUID from prefixed IDs like "agent_developer_36a2d2bb-..." or "company_e95b57fd-...".
 *
 * The contracts/db layer uses `toDbId(friendly) = uuidv5(friendly, ARCEUS_UUID_NS)`
 * when the input isn't already a bare UUID. We mirror that here so
 * `memory_units.company_id` / `agent_id` resolve to the same uuid the
 * `companies` / `agents` tables actually store. A naive regex extract
 * (e.g. pulling `acee84ad-...` out of `company_acee84ad-...`) produced
 * a UUID that did not exist in `companies.id` and the FK 23503'd.
 *
 * Single source of truth for the namespace lives in
 * `@arceus/db/src/repos/_uuid.ts`.
 */
const extractUuid = friendlyToUuid;

/**
 * Build canonical `memory_units` insert values from a domain
 * `MemoryUnit`. Spec 31 PR #13c — replaces the legacy `buildInsertValues`
 * that targeted `hippocampus.memory_units`. UUIDs are derived from
 * friendly ids via `friendlyToUuid`.
 */
function buildCanonicalInsertValues(
  unit: MemoryUnit,
  type: "static" | "dynamic",
): typeof memoryUnits.$inferInsert {
  return {
    companyId: extractUuid(unit.companyId),
    agentId: extractUuid(unit.agentId),
    content: unit.content,
    type,
    kind: unit.visibility === "private" ? null : unit.visibility,
    tags: unit.tags ?? [],
    confidence: unit.confidence,
    relevanceScore: 1.0,
    container: `company:${unit.companyId}:agent:${unit.agentId}`,
    sourceTaskId: unit.sourceTaskId ? extractUuid(unit.sourceTaskId) : null,
    expiresAt: unit.expiresAt ? new Date(unit.expiresAt) : null,
  };
}

/**
 * Upsert the embedding row for a memory unit. Inserts on first write,
 * overwrites on re-embed. Spec 31 PR #13c moved embeddings off
 * `memory_units.embedding` onto a dedicated `memory_embeddings` table
 * so this helper keeps the call sites readable.
 */
async function upsertEmbedding(memoryId: string, embedding: number[]): Promise<void> {
  const db = getDb();
  await db
    .insert(memoryEmbeddings)
    .values({ memoryId, embedding, modelVersion: EMBEDDING_MODEL_VERSION })
    .onConflictDoUpdate({
      target: memoryEmbeddings.memoryId,
      set: { embedding, modelVersion: EMBEDDING_MODEL_VERSION },
    });
}

// ---------------------------------------------------------------------------
// PgVectorStaticStore — permanent facts, never expire
// ---------------------------------------------------------------------------

/**
 * PostgreSQL + pgvector implementation of StaticMemoryStore.
 * Stores permanent facts with embedding-based vector similarity search.
 * Embeddings are generated on add/update and used for cosine distance ranking.
 */
export class PgVectorStaticStore implements StaticMemoryStore {
  async list(agentId: string): Promise<MemoryUnit[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(memoryUnits)
      .where(
        and(
          eq(memoryUnits.agentId, extractUuid(agentId)),
          eq(memoryUnits.type, "static"),
          isNull(memoryUnits.deletedAt),
        ),
      )
      .limit(MEMORY_LIST_DEFAULT_LIMIT);

    return rows.map(canonicalRowToUnit);
  }

  async add(unit: MemoryUnit): Promise<void> {
    const db = getDb();
    const values = buildCanonicalInsertValues(unit, "static");
    const [row] = await db.insert(memoryUnits).values(values).returning({ id: memoryUnits.id });
    if (!row) return;

    // Embedding is best-effort: search still works without it, but
    // ranking falls back to insertion order. The embed() call can
    // fail if the model isn't loaded yet, so we swallow the error.
    try {
      const embedding = await embed(unit.content);
      await upsertEmbedding(row.id, embedding);
    } catch (err) {
      // Row is preserved; metadata ranking is the fallback. We surface
      // the failure so the inspector + activity_log show that some rows
      // exist without embeddings (F-409 — was previously invisible).
      logEmbedFailure("static.add", unit.agentId, err);
    }
  }

  async update(id: string, content: string, confidence: number): Promise<void> {
    const db = getDb();
    await db
      .update(memoryUnits)
      .set({ content, confidence, version: sql`${memoryUnits.version} + 1` })
      .where(eq(memoryUnits.id, id));

    try {
      const embedding = await embed(content);
      await upsertEmbedding(id, embedding);
    } catch (err) {
      // Content already updated; embedding stale. Surface so the
      // inspector can flag stale-embedding memories for re-embedding.
      logEmbedFailure("static.update", id, err);
    }
  }

  async softDelete(id: string, reason: string): Promise<void> {
    const db = getDb();
    await db
      .update(memoryUnits)
      .set({ deletedAt: new Date(), deleteReason: reason })
      .where(eq(memoryUnits.id, id));
  }

  /**
   * Vector similarity search — returns top N most similar static memories.
   * Joins `memory_embeddings` for the vector; rows without an embedding
   * are excluded (the inner join filters them out, matching legacy
   * behaviour where rows whose embedding was NULL never ranked).
   */
  async searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    limit: number = 15,
  ): Promise<Array<MemoryUnit & { similarity: number }>> {
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

// ---------------------------------------------------------------------------
// PgVectorDynamicStore — temporary facts with decay
// ---------------------------------------------------------------------------

/**
 * PostgreSQL + pgvector implementation of DynamicMemoryStore.
 * Stores temporary facts with time-decay scoring:
 * decayed_score = cosine_similarity × relevance_score × 0.5^(age_days / 30).
 * GC expires temporal facts, prunes decayed relevance below 0.1, and removes
 * old low-confidence entries.
 */
export class PgVectorDynamicStore implements DynamicMemoryStore {
  async list(agentId: string): Promise<MemoryUnit[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(memoryUnits)
      .where(
        and(
          eq(memoryUnits.agentId, extractUuid(agentId)),
          eq(memoryUnits.type, "dynamic"),
          isNull(memoryUnits.deletedAt),
        ),
      )
      .limit(MEMORY_LIST_DEFAULT_LIMIT);

    return rows.map(canonicalRowToUnit);
  }

  async add(unit: MemoryUnit): Promise<void> {
    const db = getDb();
    const values = buildCanonicalInsertValues(unit, "dynamic");
    const [row] = await db.insert(memoryUnits).values(values).returning({ id: memoryUnits.id });
    if (!row) return;

    try {
      const embedding = await embed(unit.content);
      await upsertEmbedding(row.id, embedding);
    } catch (err) {
      logEmbedFailure("dynamic.add", unit.agentId, err);
    }
  }

  async update(id: string, content: string, confidence: number): Promise<void> {
    const db = getDb();
    await db
      .update(memoryUnits)
      .set({ content, confidence, version: sql`${memoryUnits.version} + 1` })
      .where(eq(memoryUnits.id, id));

    try {
      const embedding = await embed(content);
      await upsertEmbedding(id, embedding);
    } catch (err) {
      logEmbedFailure("dynamic.update", id, err);
    }
  }

  async softDelete(id: string, reason: string): Promise<void> {
    const db = getDb();
    await db
      .update(memoryUnits)
      .set({ deletedAt: new Date(), deleteReason: reason })
      .where(eq(memoryUnits.id, id));
  }

  /**
   * Vector similarity search with decay scoring.
   * `decayed_score = cosine_similarity × relevance_score × 0.5^(age_days / half_life)`
   * Inner-joins `memory_embeddings`; rows without an embedding never
   * rank (matches legacy NULL-embedding behaviour).
   */
  async searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    limit: number = 15,
  ): Promise<Array<MemoryUnit & { similarity: number; decayedScore: number }>> {
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

// ---------------------------------------------------------------------------
// PgVectorProceduralStore — habits
// ---------------------------------------------------------------------------

/**
 * PostgreSQL implementation of ProceduralMemoryStore.
 * Stores habits (trigger → action patterns) with naive token matching.
 * GC deactivates unused habits (usageCount=0) older than 30 days.
 */
export class PgVectorProceduralStore implements ProceduralMemoryStore {
  async list(agentId: string): Promise<Habit[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(habits)
      .where(
        and(
          eq(habits.agentId, extractUuid(agentId)),
          eq(habits.isActive, true),
        ),
      );

    return rows.map(canonicalHabitRowToHabit);
  }

  async findMatching(agentId: string, taskDescription: string): Promise<Habit[]> {
    // Phase 2: naive token match. Phase 6 upgrades to LLM trigger eval.
    const candidates = await this.list(agentId);
    const tokens = new Set(taskDescription.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

    return candidates.filter((habit) => {
      const triggerTokens = `${habit.trigger} ${habit.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return triggerTokens.some((token) => tokens.has(token));
    });
  }

  async add(habit: Habit): Promise<void> {
    const db = getDb();
    await db.insert(habits).values({
      companyId: extractUuid(habit.companyId),
      agentId: extractUuid(habit.agentId),
      triggerCondition: habit.trigger,
      action: habit.action,
      confidence: habit.successRate,
      usageCount: habit.usageCount,
      formedFromId: "",
      formationMode: "auto",
      isActive: habit.status === "active",
    });
  }

  async update(id: string, trigger: string, action: string, confidence: number): Promise<void> {
    const db = getDb();
    await db
      .update(habits)
      .set({
        triggerCondition: trigger,
        action,
        confidence,
        updatedAt: new Date(),
      })
      .where(eq(habits.id, id));
  }

  async softDelete(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(habits)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(habits.id, id));
  }

  async incrementUsage(agentId: string, habitIds: string[]): Promise<void> {
    if (habitIds.length === 0) return;

    const db = getDb();
    await db
      .update(habits)
      .set({ usageCount: sql`${habits.usageCount} + 1` })
      .where(
        and(
          eq(habits.agentId, extractUuid(agentId)),
          inArray(habits.id, habitIds),
        ),
      );
  }

  async gc(companyId: string): Promise<number> {
    const db = getDb();
    const deactivated = await db
      .update(habits)
      .set({ isActive: false })
      .where(
        and(
          eq(habits.companyId, extractUuid(companyId)),
          eq(habits.isActive, true),
          eq(habits.usageCount, 0),
          sql`${habits.createdAt} < now() - interval '30 days'`,
        ),
      )
      .returning({ id: habits.id });

    return deactivated.length;
  }
}

// ---------------------------------------------------------------------------
// PgVectorPrimingStore
// ---------------------------------------------------------------------------

/**
 * PostgreSQL implementation of PrimingStore.
 * Uses upsert (ON CONFLICT DO UPDATE) keyed on agentId.
 */
export class PgVectorPrimingStore implements PrimingStore {
  async get(agentId: string): Promise<PrimingState | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(primingStates)
      .where(eq(primingStates.agentId, extractUuid(agentId)))
      .limit(1);

    return rows.length > 0 ? canonicalPrimingRowToState(rows[0]) : null;
  }

  async set(state: PrimingState): Promise<void> {
    const db = getDb();
    const blob = encodePrimingState({
      confidence: state.confidence,
      caution: state.caution,
      morale: state.morale,
      recentEvents: state.recentEvents,
    });
    await db
      .insert(primingStates)
      .values({
        agentId: extractUuid(state.agentId),
        companyId: extractUuid(state.companyId),
        state: blob,
      })
      .onConflictDoUpdate({
        target: primingStates.agentId,
        set: { state: blob, updatedAt: new Date() },
      });
  }
}

// ---------------------------------------------------------------------------
// Set embedding on an existing memory unit
// ---------------------------------------------------------------------------

/**
 * Set or replace the embedding vector for an existing memory unit.
 * Spec 31 PR #13c — embeddings now live in their own table, so this
 * upserts the row instead of updating an inline column.
 */
export async function setMemoryEmbedding(memoryId: string, embedding: number[]): Promise<void> {
  await upsertEmbedding(memoryId, embedding);
}

// ---------------------------------------------------------------------------
// Factory: create pgvector-backed stores (or return null for in-memory fallback)
// ---------------------------------------------------------------------------

/**
 * Factory: create pgvector-backed stores for all four tiers.
 * Returns null if DATABASE_URL is not configured, allowing callers
 * to fall back to in-memory stores.
 */
export function createPgVectorStores() {
  if (!isDatabaseConfigured()) {
    return null;
  }

  return {
    staticStore: new PgVectorStaticStore(),
    dynamicStore: new PgVectorDynamicStore(),
    proceduralStore: new PgVectorProceduralStore(),
    primingStore: new PgVectorPrimingStore(),
  };
}
