/**
 * Hybrid-ranking primitives (pure).
 *
 * Hippocampus ranks recall candidates on vector similarity + MMR, which can miss
 * a candidate that's an EXACT keyword match but only middling semantically. These
 * helpers add a cheap keyword signal and fuse it with the vector ranking via
 * Reciprocal Rank Fusion (RRF) — rank-based, so it composes two rankings with
 * different score scales without tuning. No embeddings, no DB → fully testable.
 */

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion. Each input list is an ordered array of ids (best
 * first). An id's score is Σ 1/(k + rank) across the lists it appears in, so an
 * id ranked high in multiple lists outranks one ranked high in only one.
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): FusedResult[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "to", "for", "on", "in", "and", "or", "is", "are", "we",
  "it", "this", "that", "with", "use", "uses", "using", "be", "by", "at", "as",
]);

function contentTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Fraction of the query's content terms that appear in `text` (0..1). A
 * stopword-only query yields 0 (no signal). Case-insensitive.
 */
export function keywordOverlapScore(query: string, text: string): number {
  const qTerms = new Set(contentTerms(query));
  if (qTerms.size === 0) return 0;
  const textTerms = new Set(contentTerms(text));
  let hits = 0;
  for (const t of qTerms) if (textTerms.has(t)) hits++;
  return hits / qTerms.size;
}
