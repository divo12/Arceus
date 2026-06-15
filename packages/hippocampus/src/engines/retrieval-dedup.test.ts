/**
 * Retrieval-time content dedup tests (node:test).
 *
 * Write-side dedup only collapses near-duplicates within a single extraction
 * batch, so the same fact learned across two meetings — or present in both the
 * static and dynamic stores — can surface twice in recall. MMR only diversifies
 * on embeddings (and the in-memory fallback store has none), so exact-text dupes
 * can both survive and waste prompt budget / bias the agent by repetition.
 * `dedupeCandidatesByContent` collapses them (modulo case/punctuation), keeping
 * the strongest-scoring copy, before ranking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeCandidatesByContent, rankAndSelect } from "./retrieval.js";
import type { RawCandidate } from "./retrieval.js";

function cand(id: string, content: string, similarity: number, decayedScore?: number): RawCandidate {
  return {
    id,
    companyId: "c1",
    agentId: "a1",
    sourceTaskId: null,
    sourceArtifactId: null,
    type: decayedScore != null ? "dynamic" : "static",
    visibility: "private",
    source: "task_completion",
    content,
    summary: content.slice(0, 200),
    confidence: 0.8,
    tags: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: null,
    similarity,
    tier: decayedScore != null ? "dynamic" : "static",
    ...(decayedScore != null ? { decayedScore } : {}),
  };
}

test("empty input returns empty", () => {
  assert.deepEqual(dedupeCandidatesByContent([]), []);
});

test("collapses same content (modulo case/punctuation), keeping the higher-similarity copy", () => {
  const out = dedupeCandidatesByContent([
    cand("weak", "Use Postgres for storage.", 0.4),
    cand("strong", "use postgres for storage", 0.9),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "strong");
});

test("distinct content is preserved", () => {
  const out = dedupeCandidatesByContent([
    cand("a", "Use Postgres for storage", 0.5),
    cand("b", "Ship the onboarding flow", 0.5),
  ]);
  assert.deepEqual(out.map((c) => c.id).sort(), ["a", "b"]);
});

test("dynamic duplicates are scored by decayedScore when present", () => {
  const out = dedupeCandidatesByContent([
    cand("stale", "sprint velocity is eight", 0.9, 0.1),
    cand("fresh", "Sprint velocity is eight!", 0.5, 0.8),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "fresh", "higher decayedScore wins for dynamic memories");
});

test("rankAndSelect collapses duplicate content so topK is filled with unique memories", () => {
  const out = rankAndSelect(
    [
      cand("dup1", "Use Postgres for storage", 0.9),
      cand("dup2", "use postgres for storage.", 0.85),
      cand("other", "Ship the onboarding flow", 0.6),
    ],
    "",
    { topK: 2, lambda: 1.0 },
  );
  const contents = out.map((m) => m.content.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim());
  const unique = new Set(contents);
  assert.equal(unique.size, contents.length, "no duplicate content in recall output");
  assert.ok(out.map((m) => m.id).includes("other"), "distinct memory should fill the freed slot");
});
