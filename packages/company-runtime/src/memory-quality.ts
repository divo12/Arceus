/**
 * Memory-write quality gate (Component 6 of the memory work).
 *
 * Discipline borrowed from the Polsia teardown: don't persist everything. Every
 * LLM-extracted "fact" used to become a permanent Hippocampus memory, so trivial
 * fragments ("ok", "noted") and low-confidence guesses accumulated as noise that
 * degrades later recall. This gate is the cheap, deterministic filter applied
 * BEFORE persistence — keep substantive, confident facts; drop the rest.
 *
 * Pure (no LLM/DB) so the policy is testable and consistent across every write
 * path. Tuned conservatively: it only removes clear noise, never borderline-
 * useful memory.
 */

export interface MemorableFactLike {
  content: string;
  confidence: number;
}

/** Below this confidence a fact is an uncertain guess, not durable memory. */
export const MIN_MEMORY_CONFIDENCE = 0.35;
/** Content shorter than this (trimmed) carries no recall value. */
export const MIN_MEMORY_CONTENT_CHARS = 10;

/** True when a fact is worth persisting to long-term memory. */
export function isWorthRemembering(fact: MemorableFactLike): boolean {
  const content = (fact.content ?? "").trim();
  if (content.length < MIN_MEMORY_CONTENT_CHARS) return false;
  if (!Number.isFinite(fact.confidence) || fact.confidence < MIN_MEMORY_CONFIDENCE) return false;
  return true;
}

/** Keep only the facts worth remembering, preserving order. */
export function filterMemorableFacts<T extends MemorableFactLike>(facts: readonly T[]): T[] {
  return facts.filter(isWorthRemembering);
}

/**
 * Content-only variant for write paths that carry no confidence score (e.g.
 * structured role-memory modifications from meeting effects). Drops empty /
 * trivially short content so it never pollutes role memory.
 */
export function isSubstantiveMemoryContent(content: string): boolean {
  return (content ?? "").trim().length >= MIN_MEMORY_CONTENT_CHARS;
}
