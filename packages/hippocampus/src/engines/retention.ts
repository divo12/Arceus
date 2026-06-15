/**
 * Value-ranked memory retention (pure).
 *
 * When an agent accumulates more memories than its prompt budget, something has
 * to be evicted. Capping by pure recency (keep the N newest) silently drops
 * durable decisions the moment N transient progress notes pile on top of them —
 * exactly the "memory fills up → keep decisions, drop resolved chatter" failure
 * from the Polsia teardown.
 *
 * This selects which memories survive the cap by VALUE, not just age: durable
 * facts and handoffs (the "decisions") outrank transient dynamic notes, higher
 * confidence outranks lower, and recency breaks ties. The kept set is returned
 * newest-first so downstream render slices keep their recency semantics.
 */

export interface RetainableMemory {
  /** Memory type (static/dynamic/procedural/priming/delegation); other values weight 1. */
  type: string;
  confidence: number;
  createdAt: string | Date;
  visibility?: string;
}

/**
 * Durability weight per memory type. Static facts and delegations (handoffs)
 * are the decisions worth keeping; dynamic/priming notes are transient and the
 * first to go when space is tight. Unknown types default to 1.
 */
const TYPE_WEIGHT: Record<string, number> = {
  static: 3,
  delegation: 3,
  procedural: 2,
  dynamic: 1,
  priming: 1,
};

function epochMs(createdAt: string | Date): number {
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isNaN(t) ? 0 : t;
}

function retentionScore(m: RetainableMemory): number {
  const weight = TYPE_WEIGHT[m.type] ?? 1;
  const confidence = Number.isFinite(m.confidence) ? m.confidence : 0;
  // Team-visible memories are shared decisions — nudge them above private notes
  // of the same type/confidence.
  const sharedBonus = m.visibility === "team" || m.visibility === "shared" ? 0.5 : 0;
  return weight + confidence + sharedBonus;
}

/**
 * Keep the `max` highest-value memories. Returns a new array sorted newest-first.
 * When the input already fits, every memory is kept (just normalized to
 * newest-first order).
 */
export function selectMemoriesToRetain<T extends RetainableMemory>(units: readonly T[], max: number): T[] {
  const byRecencyDesc = (a: T, b: T) => epochMs(b.createdAt) - epochMs(a.createdAt);
  if (max <= 0) return [];
  if (units.length <= max) return [...units].sort(byRecencyDesc);

  const kept = [...units]
    .sort((a, b) => {
      const s = retentionScore(b) - retentionScore(a);
      return s !== 0 ? s : byRecencyDesc(a, b);
    })
    .slice(0, max);

  return kept.sort(byRecencyDesc);
}
