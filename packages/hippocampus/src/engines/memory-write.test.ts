/**
 * Write-path semantic upsert tests (node:test).
 *
 * Every memory write used to INSERT a new row, so a fact re-stated across tasks
 * or meetings ("we're using Postgres") accumulated as N near-identical rows —
 * store bloat that costs storage, slows search, and over-weights the fact. The
 * read-side dedup hides this at recall, but the store still grows unbounded.
 * `resolveMemoryWrite` decides UPDATE-not-APPEND: if an existing memory has the
 * same content (modulo case/punctuation), refresh it instead of inserting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMemoryWrite } from "./memory-write.js";

const existing = [
  { id: "m1", content: "We use Postgres for storage.", confidence: 0.6 },
  { id: "m2", content: "Ship the onboarding flow", confidence: 0.7 },
];

test("no existing memories → insert", () => {
  assert.deepEqual(resolveMemoryWrite({ content: "anything", confidence: 0.5 }, []), {
    action: "insert",
  });
});

test("distinct content → insert", () => {
  assert.deepEqual(
    resolveMemoryWrite({ content: "Adopt feature flags", confidence: 0.5 }, existing),
    { action: "insert" },
  );
});

test("same content modulo case/punctuation → update the existing row", () => {
  const d = resolveMemoryWrite({ content: "WE USE POSTGRES FOR STORAGE!!!", confidence: 0.9 }, existing);
  assert.equal(d.action, "update");
  if (d.action === "update") {
    assert.equal(d.targetId, "m1");
    assert.equal(d.mergedConfidence, 0.9, "keeps the higher confidence");
  }
});

test("update keeps the existing higher confidence when the incoming is weaker", () => {
  const d = resolveMemoryWrite({ content: "Ship the onboarding flow!", confidence: 0.2 }, existing);
  assert.equal(d.action, "update");
  if (d.action === "update") {
    assert.equal(d.targetId, "m2");
    assert.equal(d.mergedConfidence, 0.7);
  }
});

test("blank/whitespace content → insert (write-gating is handled upstream)", () => {
  assert.deepEqual(resolveMemoryWrite({ content: "   ", confidence: 0.5 }, existing), {
    action: "insert",
  });
});
