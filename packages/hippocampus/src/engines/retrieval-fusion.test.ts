/**
 * Keyword-fusion wiring tests (node:test).
 *
 * Hippocampus ranked recall candidates on vector similarity + tier boost + MMR
 * alone. A candidate that is an EXACT keyword match for the task but only middling
 * semantically could lose to a higher-similarity candidate that shares no terms.
 * `rankAndSelect` now optionally fuses a keyword-overlap ranking with the semantic
 * ranking (Reciprocal Rank Fusion) when `queryText` is supplied — boosting the
 * exact match without discarding semantic order. These tests pin that behavior and
 * its safe no-ops (no query / no overlap → identical to before).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankAndSelect, fuseKeywordSignal } from "./retrieval.js";
import type { RawCandidate } from "./retrieval.js";

function cand(id: string, content: string, similarity: number): RawCandidate {
  return {
    id,
    companyId: "c1",
    agentId: "a1",
    sourceTaskId: null,
    sourceArtifactId: null,
    type: "static",
    visibility: "private",
    source: "task_completion",
    content,
    summary: content.slice(0, 200),
    confidence: 0.8,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    similarity,
    tier: "static",
  };
}

const OPTS = { topK: 2, lambda: 1.0 } as const; // pure relevance → isolates fusion effect

test("without queryText, higher-similarity candidate ranks first (unchanged baseline)", () => {
  const candidates = [
    cand("sky", "the sky is blue today", 0.9),
    cand("dark", "dark mode toggle in settings", 0.5),
  ];
  const out = rankAndSelect(candidates, "", OPTS);
  assert.equal(out[0].id, "sky");
});

test("with queryText, an exact keyword match is boosted above a higher-similarity non-match", () => {
  const candidates = [
    cand("sky", "the sky is blue today", 0.9),
    cand("dark", "dark mode toggle in settings", 0.5),
  ];
  const out = rankAndSelect(candidates, "", { ...OPTS, queryText: "dark mode toggle" });
  assert.equal(out[0].id, "dark", "keyword match should win after fusion");
});

test("queryText with zero overlap leaves the semantic order untouched", () => {
  const candidates = [
    cand("sky", "the sky is blue today", 0.9),
    cand("dark", "dark mode toggle in settings", 0.5),
  ];
  const out = rankAndSelect(candidates, "", { ...OPTS, queryText: "quarterly revenue projection" });
  assert.equal(out[0].id, "sky");
});

test("fuseKeywordSignal is a no-op when queryText is empty", () => {
  const boosted = [
    { ...cand("a", "alpha content here", 0.9), boostedScore: 0.9 },
    { ...cand("b", "beta content here", 0.5), boostedScore: 0.5 },
  ];
  const out = fuseKeywordSignal(boosted, "");
  assert.deepEqual(out.map((c) => c.boostedScore), [0.9, 0.5]);
});

test("fuseKeywordSignal is a no-op when nothing matches the query", () => {
  const boosted = [
    { ...cand("a", "alpha content here", 0.9), boostedScore: 0.9 },
    { ...cand("b", "beta content here", 0.5), boostedScore: 0.5 },
  ];
  const out = fuseKeywordSignal(boosted, "nonexistent terminology");
  assert.deepEqual(out.map((c) => c.boostedScore), [0.9, 0.5]);
});
