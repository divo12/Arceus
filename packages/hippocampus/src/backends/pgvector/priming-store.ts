/**
 * pgvector backend — PrimingStore.
 * Spec 34 v3 PR 7.
 *
 * Uses upsert (ON CONFLICT DO UPDATE) keyed on agentId.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@arceus/db";
import { primingStates } from "@arceus/db/src/schema/priming_states.js";
import { encodePrimingState } from "@arceus/db/src/codecs/priming-state.js";
import type { PrimingState } from "@arceus/contracts";
import type { PrimingStore } from "../../types.js";
import { canonicalPrimingRowToState, extractUuid } from "./canonical-codec.js";

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
