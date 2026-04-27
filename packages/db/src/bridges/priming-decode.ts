/**
 * Pure legacy → canonical priming-state encoder — Spec 31 PR #13d.
 *
 * Legacy `hippocampus.priming_state` stores `confidence`, `caution`,
 * `morale`, `recent_events` as separate columns. Canonical
 * `public.priming_states` keeps an opaque `state` jsonb plus a
 * forward-looking `recent_outcomes` jsonb. We encode legacy fields
 * inside `state` (lossless) and leave `recent_outcomes` empty —
 * legacy never populated structured outcome scores, so nothing is
 * lost. The codec lives here so the runtime backend (`pgvector.ts`)
 * and the one-shot backfill script share one definition.
 */
import { friendlyToUuid } from "../repos/_uuid.js";
import type { primingStates } from "../schema/priming_states.js";

/**
 * Mirror of the legacy `hippocampus.priming_state` row.
 * `recent_events` is `string[]` in the legacy schema (e.g. event ids
 * tracked by the priming runtime).
 */
export interface LegacyPrimingRow {
  agentId: string;
  companyId: string;
  confidence: number;
  caution: number;
  morale: number;
  recentEvents: string[];
  updatedAt: Date;
}

/**
 * Shape of the canonical `state` jsonb when populated by the priming
 * codec. Unknown keys are preserved on round-trip so future runtime
 * additions don't get dropped.
 */
/**
 * Extends `Record<string, unknown>` so it's assignable to the
 * canonical `state` jsonb column type without a cast. Unknown keys
 * survive round-trip via the catch-all signature.
 */
export interface PrimingStateBlob extends Record<string, unknown> {
  confidence: number;
  caution: number;
  morale: number;
  recentEvents: string[];
}

export type NewPrimingState = typeof primingStates.$inferInsert;

/**
 * Encode legacy priming fields into the canonical `state` jsonb.
 * Defaults match the legacy CHECK constraints: confidence/caution
 * default to 0.5 and morale to 0.7.
 */
export function encodePrimingState(legacy: Pick<LegacyPrimingRow, "confidence" | "caution" | "morale" | "recentEvents">): PrimingStateBlob {
  return {
    confidence: legacy.confidence,
    caution: legacy.caution,
    morale: legacy.morale,
    recentEvents: [...legacy.recentEvents],
  };
}

/**
 * Decode the canonical `state` jsonb back into the legacy field
 * shape. Tolerant of partial blobs (returns defaults when keys are
 * missing), so a future blob-shape change can roll out without a
 * coordinated runtime restart.
 */
export function decodePrimingState(state: Record<string, unknown> | null | undefined): PrimingStateBlob {
  const blob = (state ?? {}) as Partial<PrimingStateBlob>;
  return {
    confidence: typeof blob.confidence === "number" ? blob.confidence : 0.5,
    caution: typeof blob.caution === "number" ? blob.caution : 0.5,
    morale: typeof blob.morale === "number" ? blob.morale : 0.7,
    recentEvents: Array.isArray(blob.recentEvents) ? blob.recentEvents.filter((e): e is string => typeof e === "string") : [],
  };
}

/**
 * Build canonical `priming_states` insert/upsert values from a legacy
 * row. UUIDs are derived from friendly ids; `recent_outcomes` stays
 * empty since legacy never tracked structured outcome scores.
 */
export function buildPrimingInsert(legacy: LegacyPrimingRow): NewPrimingState {
  return {
    agentId: friendlyToUuid(legacy.agentId),
    companyId: friendlyToUuid(legacy.companyId),
    state: encodePrimingState(legacy),
    recentOutcomes: [],
    updatedAt: legacy.updatedAt,
  };
}
