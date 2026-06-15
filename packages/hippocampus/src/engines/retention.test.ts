/**
 * Value-ranked retention tests (node:test).
 *
 * Pins the eviction policy: durable decisions survive the memory cap even when
 * newer transient notes would otherwise crowd them out, and the kept set stays
 * newest-first for downstream render slices.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMemoriesToRetain } from "./retention.js";
import type { RetainableMemory } from "./retention.js";

function mem(
  id: string,
  type: RetainableMemory["type"],
  confidence: number,
  createdAt: string,
  visibility = "private",
): RetainableMemory & { id: string } {
  return { id, type, confidence, createdAt, visibility };
}

test("empty input returns empty", () => {
  assert.deepEqual(selectMemoriesToRetain([], 5), []);
});

test("under the cap, every memory is kept (newest-first)", () => {
  const units = [
    mem("a", "dynamic", 0.5, "2026-06-01T00:00:00Z"),
    mem("b", "dynamic", 0.5, "2026-06-03T00:00:00Z"),
    mem("c", "static", 0.9, "2026-06-02T00:00:00Z"),
  ];
  const out = selectMemoriesToRetain(units, 5);
  assert.deepEqual(out.map((m) => m.id), ["b", "c", "a"]);
});

test("over the cap, a durable static decision survives eviction by newer dynamic notes", () => {
  const units = [
    mem("note_new", "dynamic", 0.5, "2026-06-10T00:00:00Z"),
    mem("note_old", "dynamic", 0.5, "2026-06-09T00:00:00Z"),
    mem("decision", "static", 0.9, "2026-01-01T00:00:00Z"), // oldest, but a decision
  ];
  const out = selectMemoriesToRetain(units, 2);
  const ids = out.map((m) => m.id);
  assert.ok(ids.includes("decision"), "durable decision must be retained");
  assert.ok(!ids.includes("note_old"), "lower-value note should be evicted");
  // newest-first ordering preserved in the kept set
  assert.deepEqual(ids, ["note_new", "decision"]);
});

test("same type/confidence: recency breaks the tie", () => {
  const units = [
    mem("older", "dynamic", 0.5, "2026-06-01T00:00:00Z"),
    mem("newer", "dynamic", 0.5, "2026-06-05T00:00:00Z"),
  ];
  assert.deepEqual(selectMemoriesToRetain(units, 1).map((m) => m.id), ["newer"]);
});

test("team-visible decision outranks an equal private one of the same type", () => {
  const units = [
    mem("private", "static", 0.8, "2026-06-05T00:00:00Z", "private"),
    mem("shared", "static", 0.8, "2026-06-01T00:00:00Z", "team"),
  ];
  // Both static/0.8; shared gets the visibility bonus → survives a cap of 1
  assert.deepEqual(selectMemoriesToRetain(units, 1).map((m) => m.id), ["shared"]);
});

test("handles Date createdAt as well as ISO strings", () => {
  const units = [
    { type: "dynamic" as const, confidence: 0.5, createdAt: new Date("2026-06-01T00:00:00Z"), id: "x" },
    { type: "dynamic" as const, confidence: 0.5, createdAt: new Date("2026-06-05T00:00:00Z"), id: "y" },
  ];
  assert.deepEqual(selectMemoriesToRetain(units, 2).map((m) => m.id), ["y", "x"]);
});
