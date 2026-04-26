/**
 * pgvector backend constants — central thresholds for the dynamic-memory
 * decay model and listing pagination (cluster C17 — F-413 + F-417).
 *
 * Pulling these out of the SQL templates means tuning the decay curve or
 * page size happens in one place, not three; and the pieces of the formula
 * (half-life, seconds-per-day, expiry threshold) are no longer tightly
 * coupled to the literal number `30`.
 */

/**
 * Half-life (in days) for the dynamic-memory decay formula
 *   decayed_score = similarity × relevance × 0.5^(age_days / HALF_LIFE_DAYS)
 *
 * 30 days means a memory's effective relevance drops by 50% every month it
 * sits untouched. Used in two SQL sites (live ranking + GC pruning); both
 * MUST agree, hence the shared constant.
 */
export const MEMORY_DECAY_HALF_LIFE_DAYS = 30;

/** Seconds in a day — denominator when comparing `EXTRACT(EPOCH ...)` to days. */
export const SECONDS_PER_DAY = 86400;

/**
 * Soft-delete dynamic memories whose decayed score falls below this floor.
 * 0.1 ≈ "less than 10% of the original relevance after decay" — the GC
 * pass deletes them rather than letting the table grow indefinitely.
 */
export const RELEVANCE_DECAY_DELETE_THRESHOLD = 0.1;

/**
 * Default cap on `list()` row count for static + dynamic stores. Without
 * this, a list call against an agent with 10K memories streams the whole
 * table — both memory-pressuring the API process and wasting vector
 * embeddings on memories no caller will read.
 *
 * 50 matches what every caller historically passed; expose it so future
 * code can opt into pagination explicitly.
 */
export const MEMORY_LIST_DEFAULT_LIMIT = 50;
