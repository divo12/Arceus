/**
 * Expiry-aware recall tests (node:test).
 *
 * Temporal memories carry an `expiresAt`, but expiry was enforced ONLY by the
 * periodic GC sweep (and the in-memory fallback store has no GC at all). Between
 * sweeps, an expired temporal fact ("this week's blocker is X") is still
 * deletedAt=null and would be recalled into an agent's prompt as if current.
 * `rankAndSelect` now drops expired candidates up front via the pure
 * `isMemoryLive` predicate — covering every backend regardless of GC timing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankAndSelect, isMemoryLive } from "./retrieval.js";
import type { RawCandidate } from "./retrieval.js";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const PAST = "2026-06-14T12:00:00.000Z"; // expired yesterday
const FUTURE = "2999-01-01T00:00:00.000Z"; // far future

function cand(id: string, expiresAt: string | null, similarity = 0.8): RawCandidate {
  return {
    id,
    companyId: "c1",
    agentId: "a1",
    sourceTaskId: null,
    sourceArtifactId: null,
    type: "dynamic",
    visibility: "private",
    source: "task_completion",
    content: `fact ${id}`,
    summary: `fact ${id}`,
    confidence: 0.8,
    tags: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt,
    similarity,
    tier: "dynamic",
  };
}

test("isMemoryLive: null expiry is always live", () => {
  assert.equal(isMemoryLive({ expiresAt: null }, NOW), true);
});

test("isMemoryLive: past expiry is dead, future expiry is live", () => {
  assert.equal(isMemoryLive({ expiresAt: PAST }, NOW), false);
  assert.equal(isMemoryLive({ expiresAt: FUTURE }, NOW), true);
});

test("isMemoryLive: unparseable expiry is treated as live (never silently drop)", () => {
  assert.equal(isMemoryLive({ expiresAt: "not-a-date" }, NOW), true);
});

test("rankAndSelect drops an expired candidate and keeps the live one", () => {
  const out = rankAndSelect(
    [cand("expired", PAST, 0.95), cand("live", FUTURE, 0.5)],
    "",
    { topK: 5, lambda: 1.0, now: NOW },
  );
  const ids = out.map((m) => m.id);
  assert.ok(!ids.includes("expired"), "expired temporal fact must not be recalled");
  assert.ok(ids.includes("live"), "live fact must survive");
});

test("rankAndSelect keeps non-expiring (static) candidates", () => {
  const out = rankAndSelect([cand("static", null)], "", { topK: 5, lambda: 1.0, now: NOW });
  assert.deepEqual(out.map((m) => m.id), ["static"]);
});
