import { cosineSimilarity } from "../backends/embedding.js";
import { normalizeContentKey } from "./content-key.js";
import { reciprocalRankFusion, keywordOverlapScore } from "./hybrid-rank.js";
import type { MemoryUnit } from "@arceus/contracts";
import type { RetrievalOptions, ScoredMemory } from "../types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RETRIEVAL_OPTIONS: RetrievalOptions = {
  topK: 5,
  overFetch: 3,
  lambda: 0.7,
  tierBoost: { static: 1.5, dynamic: 1.0 },
  scopeBoost: 1.3,
};

// ---------------------------------------------------------------------------
// Candidate type — what the stores give us before MMR
// ---------------------------------------------------------------------------

export type RawCandidate = MemoryUnit & {
  similarity: number;
  tier: "static" | "dynamic";
  /** Only present on dynamic memories — pre-computed by pgvector store */
  decayedScore?: number;
  /** The embedding vector, needed for inter-candidate similarity in MMR */
  embedding?: number[];
};

// ---------------------------------------------------------------------------
// Tier + scope boosting
// ---------------------------------------------------------------------------

/**
 * Apply tier and scope boosts to raw similarity scores.
 * Returns a new array — does not mutate input.
 */
export function applyBoosts(
  candidates: RawCandidate[],
  agentContainer: string,
  options: RetrievalOptions,
): (RawCandidate & { boostedScore: number })[] {
  return candidates.map((c) => {
    // Base score: for dynamic, use decayedScore if available (already includes decay)
    const baseScore = c.tier === "dynamic" && c.decayedScore != null
      ? c.decayedScore
      : c.similarity;

    // Tier boost
    const tierMultiplier = options.tierBoost[c.tier];

    // Scope boost — if the memory's container matches the agent's context
    const scopeMultiplier = agentContainer && c.content
      ? 1.0 // We don't have container on MemoryUnit output; use a heuristic below
      : 1.0;

    // For now, scope boost is applied if memory was created for the same agent
    // (the container field is in the DB row but not on the MemoryUnit type)
    // Phase 4+ can pass container through for proper scope matching

    const boostedScore = baseScore * tierMultiplier * scopeMultiplier;

    return { ...c, boostedScore };
  });
}

// ---------------------------------------------------------------------------
// Content dedup — collapse duplicate memories before ranking
// ---------------------------------------------------------------------------

/** Score used to pick the survivor among duplicates — decayed relevance for dynamic, else similarity. */
function candidateStrength(c: RawCandidate): number {
  return c.tier === "dynamic" && c.decayedScore != null ? c.decayedScore : c.similarity;
}

/**
 * Collapse candidates whose content is identical modulo case/punctuation,
 * keeping the strongest-scoring copy. Write-side dedup only runs per extraction
 * batch, so the same fact can still arrive via different sources/stores; this is
 * the read-side backstop so recall never spends prompt budget on repeats. Blank
 * content is left untouched (no key → not a duplicate of anything).
 */
export function dedupeCandidatesByContent<T extends RawCandidate>(candidates: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  const passthrough: T[] = [];
  for (const c of candidates) {
    const key = normalizeContentKey(c.content);
    if (!key) {
      passthrough.push(c);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing || candidateStrength(c) > candidateStrength(existing)) {
      byKey.set(key, c);
    }
  }
  return [...byKey.values(), ...passthrough];
}

// ---------------------------------------------------------------------------
// Expiry — drop temporal memories past their lifetime
// ---------------------------------------------------------------------------

/**
 * True when a memory is still within its lifetime at `now` (epoch ms).
 *
 * A null/absent `expiresAt` never expires. An unparseable timestamp is treated
 * as live — we never silently drop a memory because of a malformed field; the
 * authoritative cleanup is the store's GC, this is fail-open defense-in-depth so
 * an expired temporal fact can't leak into recall between GC sweeps (and so the
 * GC-less in-memory fallback store gets expiry semantics at all).
 */
export function isMemoryLive(unit: { expiresAt: string | null }, now: number): boolean {
  if (!unit.expiresAt) return true;
  const t = Date.parse(unit.expiresAt);
  if (Number.isNaN(t)) return true;
  return t > now;
}

// ---------------------------------------------------------------------------
// Keyword fusion — hybrid lexical + semantic ranking via RRF
// ---------------------------------------------------------------------------

/**
 * Fuse a keyword-overlap signal into the boosted (semantic) ranking using
 * Reciprocal Rank Fusion, so a candidate that exactly matches the task's terms
 * is lifted even if its vector similarity is only middling.
 *
 * Returns a NEW array with each candidate's `boostedScore` replaced by its fused
 * score. Safe no-ops — input returned unchanged — when:
 *   - `queryText` is empty/whitespace (no lexical signal to add), or
 *   - no candidate shares any content term with the query (fusion would be a
 *     uniform rescale that only distorts the existing semantic order).
 */
export function fuseKeywordSignal<T extends RawCandidate & { boostedScore: number }>(
  candidates: T[],
  queryText: string,
): T[] {
  if (!queryText?.trim() || candidates.length === 0) return candidates;

  const kw = candidates.map((c) =>
    keywordOverlapScore(queryText, `${c.content} ${c.summary ?? ""}`),
  );
  if (kw.every((s) => s === 0)) return candidates; // no lexical signal → leave semantic order intact

  const semanticList = [...candidates]
    .sort((a, b) => b.boostedScore - a.boostedScore)
    .map((c) => c.id);
  const keywordList = candidates
    .map((c, i) => ({ id: c.id, score: kw[i] }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);

  const fusedById = new Map(
    reciprocalRankFusion([semanticList, keywordList]).map((f) => [f.id, f.score]),
  );
  return candidates.map((c) => ({ ...c, boostedScore: fusedById.get(c.id) ?? 0 }));
}

// ---------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance) selection
// ---------------------------------------------------------------------------

/**
 * Select topK memories using MMR to balance relevance and diversity.
 *
 * For each remaining candidate:
 *   mmrScore = lambda * boostedScore - (1 - lambda) * maxSim(candidate, selected)
 *
 * If embeddings are not available, falls back to pure boosted-score ranking
 * (equivalent to lambda = 1.0).
 *
 * Internal note: we need each selected memory's embedding to compute
 * similarity against the next candidate, but the public `ScoredMemory`
 * shape doesn't carry it. Rather than tack it on with an `as any` cast,
 * we maintain a parallel typed array of embeddings indexed alongside
 * `selected`. Same semantics, no escape hatch.
 */
export function selectByMMR(
  candidates: (RawCandidate & { boostedScore: number })[],
  topK: number,
  lambda: number,
): ScoredMemory[] {
  if (candidates.length === 0) return [];

  const selected: ScoredMemory[] = [];
  const selectedEmbeddings: (number[] | null)[] = [];
  const remaining = [...candidates];

  // Normalize boosted scores to [0, 1] for fair comparison with similarity
  const maxBoosted = Math.max(...remaining.map((c) => c.boostedScore), 0.001);

  for (let i = 0; i < topK && remaining.length > 0; i++) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (let j = 0; j < remaining.length; j++) {
      const candidate = remaining[j];
      const normalizedRelevance = candidate.boostedScore / maxBoosted;

      // Max similarity to already-selected memories
      let maxSimToSelected = 0;
      if (candidate.embedding && selectedEmbeddings.length > 0) {
        for (const selEmbedding of selectedEmbeddings) {
          if (selEmbedding) {
            const sim = cosineSimilarity(candidate.embedding, selEmbedding);
            if (sim > maxSimToSelected) maxSimToSelected = sim;
          }
        }
      }

      const mmrScore = lambda * normalizedRelevance - (1 - lambda) * maxSimToSelected;

      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestIdx = j;
      }
    }

    if (bestIdx === -1) break;

    const winner = remaining.splice(bestIdx, 1)[0];

    // Build ScoredMemory — strip embedding to keep output clean
    const scored: ScoredMemory = {
      id: winner.id,
      companyId: winner.companyId,
      agentId: winner.agentId,
      sourceTaskId: winner.sourceTaskId,
      sourceArtifactId: winner.sourceArtifactId,
      type: winner.type,
      visibility: winner.visibility,
      source: winner.source,
      content: winner.content,
      summary: winner.summary,
      confidence: winner.confidence,
      tags: winner.tags,
      createdAt: winner.createdAt,
      expiresAt: winner.expiresAt,
      similarity: winner.similarity,
      finalScore: bestMMR,
      tier: winner.tier,
    };

    selected.push(scored);
    selectedEmbeddings.push(winner.embedding ?? null);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Full retrieval pipeline (pure function — no I/O)
// ---------------------------------------------------------------------------

/**
 * Given raw candidates from both stores, apply boosts and MMR selection.
 * This is a pure function — all I/O (embedding, DB queries) happens in the caller.
 */
export function rankAndSelect(
  candidates: RawCandidate[],
  agentContainer: string,
  options: Partial<RetrievalOptions> = {},
): ScoredMemory[] {
  const opts = { ...DEFAULT_RETRIEVAL_OPTIONS, ...options };

  if (candidates.length === 0) return [];

  // Step 0: Drop temporal memories past their expiry. The store's GC is the
  // authoritative sweep, but it runs periodically — this keeps an already-
  // expired fact out of recall in the window before GC catches it (and gives
  // the GC-less in-memory fallback store expiry semantics at all).
  const now = opts.now ?? Date.now();
  const live = candidates.filter((c) => isMemoryLive(c, now));
  if (live.length === 0) return [];

  // Step 0.5: Collapse duplicate content so a fact arriving via multiple
  // sources/stores doesn't occupy multiple recall slots (read-side backstop to
  // the per-batch write dedup; also covers the no-embedding fallback where MMR
  // can't diversify).
  const unique = dedupeCandidatesByContent(live);

  // Step 1: Apply tier and scope boosts
  let boosted = applyBoosts(unique, agentContainer, opts);

  // Step 2: Fuse the keyword-overlap signal into the semantic ranking (no-op
  // unless a query is supplied and at least one candidate matches its terms).
  if (opts.queryText) {
    boosted = fuseKeywordSignal(boosted, opts.queryText);
  }

  // Step 3: Sort by (possibly fused) boosted score descending (pre-filter for MMR)
  boosted.sort((a, b) => b.boostedScore - a.boostedScore);

  // Step 4: MMR selection
  return selectByMMR(boosted, opts.topK, opts.lambda);
}
