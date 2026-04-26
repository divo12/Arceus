import { eq, and, isNull, sql, gt, desc, cosineDistance } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { getDb, isDatabaseConfigured, memoryUnitsTable, habitsTable, primingStateTable } from "@arceus/db";
import type { MemoryUnit, Habit, PrimingState } from "@arceus/contracts";
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

/** Convert a Drizzle memory_units row to the domain MemoryUnit type. */
function memoryRowToUnit(row: typeof memoryUnitsTable.$inferSelect): MemoryUnit {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    sourceTaskId: row.sourceId,
    sourceArtifactId: null,
    type: row.memoryType as MemoryUnit["type"],
    visibility: row.visibility as MemoryUnit["visibility"],
    source: (row.sourceType ?? "system") as MemoryUnit["source"],
    content: row.content,
    summary: row.content.slice(0, 200),
    confidence: row.confidence,
    tags: [],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** Convert a Drizzle habits row to the domain Habit type. */
function habitRowToHabit(row: typeof habitsTable.$inferSelect): Habit {
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

/** Convert a Drizzle priming_state row to the domain PrimingState type. */
function primingRowToState(row: typeof primingStateTable.$inferSelect): PrimingState {
  return {
    id: `priming_${row.agentId}`,
    companyId: row.companyId,
    agentId: row.agentId,
    confidence: row.confidence,
    caution: row.caution,
    morale: row.morale,
    lastDisposition: "",
    recentEvents: row.recentEvents as string[],
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Extract the raw UUID from prefixed IDs like "agent_developer_36a2d2bb-..." or "company_e95b57fd-...". */
function extractUuid(prefixedId: string): string {
  // The contracts/db layer uses `toDbId(friendly) = uuidv5(friendly, ARCEUS_UUID_NS)`
  // when the input isn't already a bare UUID. We mirror that here so that
  // `memory_units.company_id` / `agent_id` resolve to the same uuid the
  // `companies` / `agents` tables actually store. A naive regex extract
  // (e.g. pulling `acee84ad-...` out of `company_acee84ad-...`) produces
  // a UUID that does not exist in `companies.id` and the FK 23503's.
  const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_RE.test(prefixedId)) return prefixedId;
  return uuidv5(prefixedId, ARCEUS_UUID_NS);
}

/** Build the Drizzle insert values for a memory unit, extracting UUIDs from prefixed IDs. */
function buildInsertValues(unit: MemoryUnit, memoryType: "static" | "dynamic") {
  return {
    id: crypto.randomUUID(),
    companyId: extractUuid(unit.companyId),
    agentId: extractUuid(unit.agentId),
    content: unit.content,
    memoryType,
    // Shadow column — see comment on `memory_units.type` in
    // memory-tables.ts. Without this every insert into a DB whose live
    // schema still has `type NOT NULL` (no default) crashes with 23502
    // and `processTaskCompletion` aborts the whole beat.
    type: memoryType,
    confidence: unit.confidence,
    relevanceScore: 1.0,
    container: `company:${unit.companyId}:agent:${unit.agentId}`,
    visibility: unit.visibility === "team" ? "shared" : "private",
    sourceType: unit.source === "role_seed" ? "system" : unit.source ?? null,
    sourceId: unit.sourceTaskId,
    expiresAt: unit.expiresAt ? new Date(unit.expiresAt) : null,
  };
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
      .from(memoryUnitsTable)
      .where(
        and(
          eq(memoryUnitsTable.agentId, extractUuid(agentId)),
          eq(memoryUnitsTable.memoryType, "static"),
          isNull(memoryUnitsTable.deletedAt),
        ),
      )
      .limit(MEMORY_LIST_DEFAULT_LIMIT);

    return rows.map(memoryRowToUnit);
  }

  async add(unit: MemoryUnit): Promise<void> {
    const db = getDb();
    const values = buildInsertValues(unit, "static");
    // Generate embedding for vector search (fire-and-forget update if embedding fails)
    try {
      const embedding = await embed(unit.content);
      await db.insert(memoryUnitsTable).values({ ...values, embedding });
    } catch {
      await db.insert(memoryUnitsTable).values(values);
    }
  }

  async update(id: string, content: string, confidence: number): Promise<void> {
    const db = getDb();
    try {
      const embedding = await embed(content);
      await db.update(memoryUnitsTable)
        .set({ content, confidence, embedding, version: sql`${memoryUnitsTable.version} + 1` })
        .where(eq(memoryUnitsTable.id, id));
    } catch {
      await db.update(memoryUnitsTable)
        .set({ content, confidence, version: sql`${memoryUnitsTable.version} + 1` })
        .where(eq(memoryUnitsTable.id, id));
    }
  }

  async softDelete(id: string, reason: string): Promise<void> {
    const db = getDb();
    await db.update(memoryUnitsTable)
      .set({ deletedAt: new Date(), deleteReason: reason })
      .where(eq(memoryUnitsTable.id, id));
  }

  /**
   * Vector similarity search — returns top N most similar static memories.
   * Uses Drizzle's native cosineDistance operator.
   */
  async searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    limit: number = 15,
  ): Promise<Array<MemoryUnit & { similarity: number }>> {
    const db = getDb();
    const similarity = sql<number>`1 - (${cosineDistance(memoryUnitsTable.embedding, queryEmbedding)})`;

    const rows = await db
      .select({
        memoryUnit: memoryUnitsTable,
        similarity,
      })
      .from(memoryUnitsTable)
      .where(
        and(
          eq(memoryUnitsTable.agentId, extractUuid(agentId)),
          eq(memoryUnitsTable.memoryType, "static"),
          isNull(memoryUnitsTable.deletedAt),
        ),
      )
      .orderBy(desc(similarity))
      .limit(limit);

    return rows.map((row) => ({
      ...memoryRowToUnit(row.memoryUnit),
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
      .from(memoryUnitsTable)
      .where(
        and(
          eq(memoryUnitsTable.agentId, extractUuid(agentId)),
          eq(memoryUnitsTable.memoryType, "dynamic"),
          isNull(memoryUnitsTable.deletedAt),
        ),
      )
      .limit(MEMORY_LIST_DEFAULT_LIMIT);

    return rows.map(memoryRowToUnit);
  }

  async add(unit: MemoryUnit): Promise<void> {
    const db = getDb();
    const values = buildInsertValues(unit, "dynamic");
    try {
      const embedding = await embed(unit.content);
      await db.insert(memoryUnitsTable).values({ ...values, embedding });
    } catch {
      await db.insert(memoryUnitsTable).values(values);
    }
  }

  async update(id: string, content: string, confidence: number): Promise<void> {
    const db = getDb();
    try {
      const embedding = await embed(content);
      await db.update(memoryUnitsTable)
        .set({ content, confidence, embedding, version: sql`${memoryUnitsTable.version} + 1` })
        .where(eq(memoryUnitsTable.id, id));
    } catch {
      await db.update(memoryUnitsTable)
        .set({ content, confidence, version: sql`${memoryUnitsTable.version} + 1` })
        .where(eq(memoryUnitsTable.id, id));
    }
  }

  async softDelete(id: string, reason: string): Promise<void> {
    const db = getDb();
    await db.update(memoryUnitsTable)
      .set({ deletedAt: new Date(), deleteReason: reason })
      .where(eq(memoryUnitsTable.id, id));
  }

  /**
   * Vector similarity search with decay scoring.
   * decayed_score = cosine_similarity * relevance_score * 0.5^(age_days / 30)
   */
  async searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    limit: number = 15,
  ): Promise<Array<MemoryUnit & { similarity: number; decayedScore: number }>> {
    const db = getDb();
    const similarity = sql<number>`1 - (${cosineDistance(memoryUnitsTable.embedding, queryEmbedding)})`;
    // Decay: half the score every MEMORY_DECAY_HALF_LIFE_DAYS days untouched.
    const decayedScore = sql<number>`
      (1 - (${cosineDistance(memoryUnitsTable.embedding, queryEmbedding)}))
      * ${memoryUnitsTable.relevanceScore}
      * POWER(0.5, EXTRACT(EPOCH FROM (now() - ${memoryUnitsTable.updatedAt})) / ${DECAY_PERIOD_SECONDS}.0)
    `;

    const rows = await db
      .select({
        memoryUnit: memoryUnitsTable,
        similarity,
        decayedScore,
      })
      .from(memoryUnitsTable)
      .where(
        and(
          eq(memoryUnitsTable.agentId, extractUuid(agentId)),
          eq(memoryUnitsTable.memoryType, "dynamic"),
          isNull(memoryUnitsTable.deletedAt),
        ),
      )
      .orderBy(desc(decayedScore))
      .limit(limit);

    return rows.map((row) => ({
      ...memoryRowToUnit(row.memoryUnit),
      similarity: row.similarity,
      decayedScore: row.decayedScore,
    }));
  }

  async gc(companyId: string): Promise<number> {
    const db = getDb();
    let deleted = 0;

    // 1. Expire temporal facts
    const expired = await db
      .update(memoryUnitsTable)
      .set({ deletedAt: new Date(), deleteReason: "expired" })
      .where(
        and(
          eq(memoryUnitsTable.companyId, extractUuid(companyId)),
          isNull(memoryUnitsTable.deletedAt),
          sql`${memoryUnitsTable.expiresAt} IS NOT NULL AND ${memoryUnitsTable.expiresAt} < now()`,
        ),
      )
      .returning({ id: memoryUnitsTable.id });
    deleted += expired.length;

    // 2. Soft-delete dynamic memories with decayed relevance below threshold
    // Same decay formula as searchByEmbedding above — both must agree, hence
    // the shared MEMORY_DECAY_HALF_LIFE_DAYS / RELEVANCE_DECAY_DELETE_THRESHOLD.
    const decayed = await db.execute(sql`
      UPDATE memory_units
      SET deleted_at = now(), delete_reason = 'relevance_decay'
      WHERE company_id = ${companyId}
        AND memory_type = 'dynamic'
        AND deleted_at IS NULL
        AND relevance_score * POWER(0.5, EXTRACT(EPOCH FROM (now() - updated_at)) / ${DECAY_PERIOD_SECONDS}.0) < ${RELEVANCE_DECAY_DELETE_THRESHOLD}
    `);
    // drizzle's `db.execute(sql\`...\`)` return type varies by driver:
    //   postgres-js  → { length: number }   (it's an Array-like)
    //   node-postgres → { rowCount: number }
    // Both are present at runtime; the union isn't surfaced by drizzle, so we
    // read whichever is defined.
    const decayedResult = decayed as { length?: number; rowCount?: number };
    deleted += Number(decayedResult.length ?? decayedResult.rowCount ?? 0);

    // 3. Prune stale: old, low-confidence dynamic facts
    const pruned = await db
      .update(memoryUnitsTable)
      .set({ deletedAt: new Date(), deleteReason: "stale_prune" })
      .where(
        and(
          eq(memoryUnitsTable.companyId, extractUuid(companyId)),
          eq(memoryUnitsTable.memoryType, "dynamic"),
          isNull(memoryUnitsTable.deletedAt),
          sql`${memoryUnitsTable.createdAt} < now() - interval '30 days'`,
          sql`${memoryUnitsTable.confidence} < 0.3`,
        ),
      )
      .returning({ id: memoryUnitsTable.id });
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
      .from(habitsTable)
      .where(
        and(
          eq(habitsTable.agentId, agentId),
          eq(habitsTable.isActive, true),
        ),
      );

    return rows.map(habitRowToHabit);
  }

  async findMatching(agentId: string, taskDescription: string): Promise<Habit[]> {
    // Phase 2: naive token match. Phase 6 upgrades to LLM trigger eval.
    const habits = await this.list(agentId);
    const tokens = new Set(taskDescription.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

    return habits.filter((habit) => {
      const triggerTokens = `${habit.trigger} ${habit.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return triggerTokens.some((token) => tokens.has(token));
    });
  }

  async add(habit: Habit): Promise<void> {
    const db = getDb();
    await db.insert(habitsTable).values({
      id: habit.id,
      companyId: habit.companyId,
      agentId: habit.agentId,
      triggerCondition: habit.trigger,
      action: habit.action,
      confidence: habit.successRate,
      usageCount: habit.usageCount,
      formedFromId: "",
      formationMode: "auto",
      isActive: habit.status === "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async update(id: string, trigger: string, action: string, confidence: number): Promise<void> {
    const db = getDb();
    await db
      .update(habitsTable)
      .set({
        triggerCondition: trigger,
        action,
        confidence,
        updatedAt: new Date(),
      })
      .where(eq(habitsTable.id, id));
  }

  async softDelete(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(habitsTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(habitsTable.id, id));
  }

  async incrementUsage(agentId: string, habitIds: string[]): Promise<void> {
    if (habitIds.length === 0) return;

    const db = getDb();
    await db
      .update(habitsTable)
      .set({ usageCount: sql`${habitsTable.usageCount} + 1` })
      .where(
        and(
          eq(habitsTable.agentId, agentId),
          sql`${habitsTable.id} = ANY(ARRAY[${sql.join(habitIds.map((id) => sql`${id}`), sql`, `)}]::text[])`,
        ),
      );
  }

  async gc(companyId: string): Promise<number> {
    const db = getDb();
    const deactivated = await db
      .update(habitsTable)
      .set({ isActive: false })
      .where(
        and(
          eq(habitsTable.companyId, companyId),
          eq(habitsTable.isActive, true),
          eq(habitsTable.usageCount, 0),
          sql`${habitsTable.createdAt} < now() - interval '30 days'`,
        ),
      )
      .returning({ id: habitsTable.id });

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
      .from(primingStateTable)
      .where(eq(primingStateTable.agentId, agentId))
      .limit(1);

    return rows.length > 0 ? primingRowToState(rows[0]) : null;
  }

  async set(state: PrimingState): Promise<void> {
    const db = getDb();
    await db
      .insert(primingStateTable)
      .values({
        agentId: state.agentId,
        companyId: state.companyId,
        confidence: state.confidence,
        caution: state.caution,
        morale: state.morale,
        recentEvents: state.recentEvents,
      })
      .onConflictDoUpdate({
        target: primingStateTable.agentId,
        set: {
          confidence: state.confidence,
          caution: state.caution,
          morale: state.morale,
          recentEvents: state.recentEvents,
        },
      });
  }
}

// ---------------------------------------------------------------------------
// Set embedding on an existing memory unit
// ---------------------------------------------------------------------------

/** Set or replace the embedding vector on an existing memory unit row. */
export async function setMemoryEmbedding(memoryId: string, embedding: number[]): Promise<void> {
  const db = getDb();
  await db
    .update(memoryUnitsTable)
    .set({ embedding })
    .where(eq(memoryUnitsTable.id, memoryId));
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
