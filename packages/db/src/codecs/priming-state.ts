/**
 * Priming-state JSONB codec.
 *
 * The canonical `priming_states.state` column is an opaque jsonb.
 * Inside that blob the runtime stores `confidence`, `caution`,
 * `morale`, and `recentEvents`. This codec is the single source of
 * truth for that shape — both the pgvector backend (read/write
 * runtime path) and any future tooling that introspects priming
 * state import from here.
 *
 * Tolerant decoder: returns sensible defaults for missing keys so a
 * shape change can roll out without a coordinated runtime restart.
 */
import type { primingStates } from "../schema/priming_states.js";

/**
 * Shape of the canonical `state` jsonb when populated by the priming
 * codec. Extends `Record<string, unknown>` so it's directly
 * assignable to drizzle's jsonb column type, and unknown keys
 * survive round-trip via the catch-all index signature.
 */
export interface PrimingStateBlob extends Record<string, unknown> {
  confidence: number;
  caution: number;
  morale: number;
  recentEvents: string[];
}

export type NewPrimingState = typeof primingStates.$inferInsert;

/** Defaults match the legacy CHECK constraints from spec 05a. */
const DEFAULTS = { confidence: 0.5, caution: 0.5, morale: 0.7 } as const;

/**
 * Encode the runtime priming fields into the canonical `state` jsonb.
 * Keeps `recentEvents` as an immutable copy so callers can't mutate
 * the input array after the row is queued for persistence.
 */
export function encodePrimingState(input: {
  confidence: number;
  caution: number;
  morale: number;
  recentEvents: string[];
}): PrimingStateBlob {
  return {
    confidence: input.confidence,
    caution: input.caution,
    morale: input.morale,
    recentEvents: [...input.recentEvents],
  };
}

/**
 * Decode the canonical `state` jsonb back into the runtime field
 * shape. Tolerant of partial blobs and stray keys — invalid types
 * fall back to defaults rather than throwing, so a runtime that
 * loads a row written by an older version doesn't crash.
 */
export function decodePrimingState(state: Record<string, unknown> | null | undefined): PrimingStateBlob {
  const blob = (state ?? {}) as Partial<PrimingStateBlob>;
  return {
    confidence: typeof blob.confidence === "number" ? blob.confidence : DEFAULTS.confidence,
    caution: typeof blob.caution === "number" ? blob.caution : DEFAULTS.caution,
    morale: typeof blob.morale === "number" ? blob.morale : DEFAULTS.morale,
    recentEvents: Array.isArray(blob.recentEvents)
      ? blob.recentEvents.filter((e): e is string => typeof e === "string")
      : [],
  };
}
