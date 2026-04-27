/**
 * Pure legacy → canonical memory decoders — Spec 31 PR #13b.
 *
 * Single source of truth for the column-by-column conversion from the
 * legacy `hippocampus.memory_units` row shape to the new
 * `public.memory_units` shape. Pure functions only — no I/O, no module
 * state. Lives in `@arceus/db` so both consumers can import it:
 *
 *   - `apps/api/src/persistence/memory-bridge.ts` (online dual-write)
 *   - `packages/db/src/scripts/backfill-memory.ts` (bulk backfill)
 *
 * If a future schema change needs a new decoder branch, it goes here
 * once and both call sites pick it up automatically.
 */
import { friendlyToUuid } from "../repos/_uuid.js";
import type { memoryUnits } from "../schema/memory_units.js";

// ---------------------------------------------------------------------------
// Legacy row shape — the columns we read from `hippocampus.memory_units`
// ---------------------------------------------------------------------------

export type LegacyMemoryType = "static" | "dynamic" | "behavioral";
export type LegacyVisibility = "private" | "task_scoped" | "shared" | "board";
export type LegacySourceType = "task" | "meeting" | "delegation" | "system";

/**
 * Mirror of the legacy `hippocampus.memory_units` row — only the
 * columns the new schema actually consumes. Bookkeeping the redesign
 * drops (`previous_version_id`) is not part of this surface.
 *
 * PR #13c expanded the surface: `relevanceScore`, `container`,
 * `deletedAt`, `deleteReason`, and `version` carry over so the
 * dynamic-store decay/GC and soft-delete behaviour is preserved on
 * the canonical side.
 */
export interface LegacyMemoryRow {
  id: string;
  companyId: string;
  agentId: string;
  content: string;
  memoryType: LegacyMemoryType;
  confidence: number;
  relevanceScore: number;
  container: string;
  visibility: LegacyVisibility;
  sourceType: LegacySourceType | null;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  version: number;
  deletedAt: Date | null;
  deleteReason: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  embedding: number[] | null;
}

// ---------------------------------------------------------------------------
// Embedding metadata
// ---------------------------------------------------------------------------

/**
 * Stable label written to `memory_embeddings.model_version`. The
 * legacy column produced 384-dim vectors via `all-MiniLM-L6-v2`
 * (see `packages/hippocampus/src/backends/embedding.ts`). The `@384`
 * suffix lets a future model rollout key off the version string
 * rather than the column type.
 */
export const LEGACY_EMBEDDING_MODEL = "all-MiniLM-L6-v2@384";

/**
 * Curated subset of `metadata` keys lifted into the new `tags`
 * text[] column. Everything else in the JSON blob is operational
 * noise (TTL hints, ingest source, …) that would dilute search if
 * dumped wholesale. Order is preserved for stable diffs.
 */
const TAGGED_METADATA_KEYS = ["tag", "category", "priority"] as const;

// ---------------------------------------------------------------------------
// Pure transforms
// ---------------------------------------------------------------------------

/**
 * Spec 05a allowed `memory_type='behavioral'` as a third variant; the
 * redesign collapses it into the standard `'procedural'` term that
 * the rest of the codebase already uses for habit-formed knowledge.
 */
export function decodeMemoryType(
  legacy: LegacyMemoryType,
): "static" | "dynamic" | "procedural" {
  return legacy === "behavioral" ? "procedural" : legacy;
}

/**
 * Visibility was a four-valued enum keyed off legacy auth scopes.
 * `'private'` carries no signal in the new schema (it's the implicit
 * case), so we collapse it to `NULL kind` and pass the rest through
 * verbatim. Future `kind` values can be added without touching this.
 */
export function decodeKind(visibility: LegacyVisibility): string | null {
  return visibility === "private" ? null : visibility;
}

/**
 * Lift a curated subset of metadata keys into `tags`. Non-string
 * values, missing keys, and empty strings are dropped so the array
 * column never contains nulls or whitespace-only entries.
 */
export function decodeTags(metadata: Record<string, unknown>): string[] {
  return TAGGED_METADATA_KEYS
    .map((key) => metadata[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

// ---------------------------------------------------------------------------
// Insert builder
// ---------------------------------------------------------------------------

/** Drizzle insert shape derived from the canonical schema. */
export type NewMemoryUnit = typeof memoryUnits.$inferInsert;

/**
 * Build the canonical `memory_units` insert values from a legacy row.
 *
 * `sourceTaskId` is taken as a parameter rather than resolved here so
 * this function stays pure — the caller (online dual-write or bulk
 * backfill) does the FK lookup with whichever DB client it owns.
 * Pass `null` when the legacy row's source isn't a task or the task
 * no longer exists.
 */
export function buildMemoryUnitInsert(
  legacy: LegacyMemoryRow,
  sourceTaskId: string | null,
): NewMemoryUnit {
  return {
    legacyId: legacy.id,
    companyId: friendlyToUuid(legacy.companyId),
    agentId: friendlyToUuid(legacy.agentId),
    type: decodeMemoryType(legacy.memoryType),
    kind: decodeKind(legacy.visibility),
    content: legacy.content,
    tags: decodeTags(legacy.metadata),
    confidence: legacy.confidence,
    relevanceScore: legacy.relevanceScore,
    container: legacy.container,
    deletedAt: legacy.deletedAt,
    deleteReason: legacy.deleteReason,
    version: legacy.version,
    sourceTaskId,
    sourceBeatId: null,
    expiresAt: legacy.expiresAt,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  };
}
