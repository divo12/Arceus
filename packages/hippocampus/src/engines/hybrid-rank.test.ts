/**
 * Tests for hybrid-ranking primitives (from the Polsia retrieval-pipeline idea).
 *
 * Hippocampus ranks recall candidates on vector similarity + MMR alone, so it can
 * miss a candidate that is an EXACT keyword match but semantically middling. These
 * pure primitives add a keyword signal and fuse it with the vector ranking via
 * Reciprocal Rank Fusion — a candidate ranked high by BOTH signals gets boosted
 * above one ranked high by only one. Pure → testable without embeddings/DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reciprocalRankFusion, keywordOverlapScore } from "./hybrid-rank.js";

test("RRF of a single list preserves its order", () => {
  const fused = reciprocalRankFusion([["a", "b", "c"]]);
  assert.deepEqual(fused.map((r) => r.id), ["a", "b", "c"]);
});

test("RRF boosts an item ranked high in BOTH lists above one high in only one", () => {
  // 'x' is #1 in list A and #2 in list B → should win overall.
  // 'y' is #1 in list B but #4 in list A.
  const fused = reciprocalRankFusion([
    ["x", "p", "q", "y"],
    ["y", "x", "p", "q"],
  ]);
  assert.equal(fused[0].id, "x");
});

test("RRF still scores an item present in only one list", () => {
  const fused = reciprocalRankFusion([["a", "b"], ["c"]]);
  const ids = fused.map((r) => r.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("RRF scores are descending", () => {
  const fused = reciprocalRankFusion([["a", "b", "c"], ["a", "c", "b"]]);
  for (let i = 1; i < fused.length; i++) {
    assert.ok(fused[i - 1].score >= fused[i].score);
  }
});

test("keywordOverlapScore: all query terms present → 1, none → 0, partial in between", () => {
  assert.equal(keywordOverlapScore("dark theme", "we use a dark theme everywhere"), 1);
  assert.equal(keywordOverlapScore("signup wall", "the dashboard is blue"), 0);
  const partial = keywordOverlapScore("dark minimal theme", "a dark theme");
  assert.ok(partial > 0 && partial < 1);
});

test("keywordOverlapScore ignores case and stopword-only queries", () => {
  assert.equal(keywordOverlapScore("DARK Theme", "dark theme"), 1);
  assert.equal(keywordOverlapScore("the a of", "anything"), 0, "stopword-only query has no signal");
});
