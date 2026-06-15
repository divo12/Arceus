/**
 * pgvector backend — shared CRUD base for memory_units-backed stores.
 * Spec 34 v3 PR 7.
 *
 * `list` / `add` / `update` / `softDelete` are identical between the
 * Static and Dynamic stores apart from the `type` discriminator on the
 * `memory_units` row. The base centralizes that pattern; subclasses
 * provide their `type` constant and override `searchByEmbedding` (which
 * differs: Static = raw similarity, Dynamic = decayed score + relevance).
 */
import { eq, and, isNull, sql } from "drizzle-orm";
import { getDb } from "@arceus/db";
import { memoryUnits } from "@arceus/db/src/schema/memory_units.js";
import type { MemoryUnit } from "@arceus/contracts";
import { embed } from "../embedding.js";
import { MEMORY_LIST_DEFAULT_LIMIT } from "../pgvector-config.js";
import {
  buildCanonicalInsertValues,
  canonicalRowToUnit,
  extractUuid,
} from "./canonical-codec.js";
import { logEmbedFailure, upsertEmbedding } from "./embedding.js";
import { resolveMemoryWrite } from "../../engines/memory-write.js";

export abstract class BasePgVectorMemoryStore<T extends "static" | "dynamic"> {
  protected abstract readonly type: T;

  async list(agentId: string): Promise<MemoryUnit[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(memoryUnits)
      .where(
        and(
          eq(memoryUnits.agentId, extractUuid(agentId)),
          eq(memoryUnits.type, this.type),
          isNull(memoryUnits.deletedAt),
        ),
      )
      .limit(MEMORY_LIST_DEFAULT_LIMIT);

    return rows.map(canonicalRowToUnit);
  }

  async add(unit: MemoryUnit): Promise<void> {
    const db = getDb();

    // UPDATE-not-APPEND: if this agent already holds the same fact (content
    // modulo case/punctuation), refresh it instead of inserting a duplicate row
    // — keeps the store from bloating with re-stated facts at the source.
    const existing = await this.list(unit.agentId);
    const decision = resolveMemoryWrite(unit, existing);
    if (decision.action === "update") {
      await this.update(decision.targetId, unit.content, decision.mergedConfidence);
      return;
    }

    const values = buildCanonicalInsertValues(unit, this.type);
    const [row] = await db.insert(memoryUnits).values(values).returning({ id: memoryUnits.id });
    if (!row) return;

    // Embedding is best-effort: search still works without it, but
    // ranking falls back to insertion order. The embed() call can
    // fail if the model isn't loaded yet, so we swallow the error
    // and surface it to observability (F-409).
    try {
      const embedding = await embed(unit.content);
      await upsertEmbedding(row.id, embedding);
    } catch (err) {
      logEmbedFailure(`${this.type}.add`, unit.agentId, err);
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
      logEmbedFailure(`${this.type}.update`, id, err);
    }
  }

  async softDelete(id: string, reason: string): Promise<void> {
    const db = getDb();
    await db
      .update(memoryUnits)
      .set({ deletedAt: new Date(), deleteReason: reason })
      .where(eq(memoryUnits.id, id));
  }
}
