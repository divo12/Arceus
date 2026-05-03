/**
 * pgvector backend — row ↔ domain codec helpers.
 * Spec 34 v3 PR 7.
 */
import { memoryUnits } from "@arceus/db/src/schema/memory_units.js";
import { habits } from "@arceus/db/src/schema/habits.js";
import { primingStates } from "@arceus/db/src/schema/priming_states.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import { decodePrimingState } from "@arceus/db/src/codecs/priming-state.js";
import type { MemoryUnit, Habit, PrimingState } from "@arceus/contracts";

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
export const extractUuid = friendlyToUuid;

/**
 * Convert a canonical `public.memory_units` row to the domain
 * `MemoryUnit` type. Spec 31 PR #13c — the `kind` column carries what
 * legacy stored as `visibility`, and `source` is derived from the
 * presence of `source_task_id` (the canonical schema collapses
 * legacy's `source_type` enum into the FK relationship).
 */
export function canonicalRowToUnit(row: typeof memoryUnits.$inferSelect): MemoryUnit {
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
export function canonicalHabitRowToHabit(row: typeof habits.$inferSelect): Habit {
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
export function canonicalPrimingRowToState(row: typeof primingStates.$inferSelect): PrimingState {
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
 * Build canonical `memory_units` insert values from a domain
 * `MemoryUnit`. Spec 31 PR #13c — replaces the legacy `buildInsertValues`
 * that targeted `hippocampus.memory_units`. UUIDs are derived from
 * friendly ids via `friendlyToUuid`.
 */
export function buildCanonicalInsertValues(
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
