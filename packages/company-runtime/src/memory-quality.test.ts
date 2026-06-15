/**
 * Tests for the memory-write quality gate (Component 6 of the memory work).
 *
 * Today every LLM-extracted "fact" is persisted into Hippocampus unconditionally,
 * so low-signal fragments and uncertain guesses become permanent memory noise
 * that degrades later recall. isWorthRemembering is a deterministic gate applied
 * before persistence: drop empty/trivial content and low-confidence facts, keep
 * the substantive ones. Pure → testable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWorthRemembering,
  filterMemorableFacts,
  isSubstantiveMemoryContent,
  dedupeFactsByContent,
  MIN_MEMORY_CONFIDENCE,
  MIN_MEMORY_CONTENT_CHARS,
} from "./memory-quality.js";

test("keeps a substantive, confident fact", () => {
  assert.equal(
    isWorthRemembering({ content: "The board wants a dark theme across the whole product.", confidence: 0.9 }),
    true,
  );
});

test("drops empty / whitespace / too-short content", () => {
  assert.equal(isWorthRemembering({ content: "", confidence: 0.9 }), false);
  assert.equal(isWorthRemembering({ content: "   ", confidence: 0.9 }), false);
  assert.equal(isWorthRemembering({ content: "ok", confidence: 0.9 }), false);
});

test("drops low-confidence facts (uncertain guesses are not durable memory)", () => {
  assert.equal(
    isWorthRemembering({ content: "Maybe the user prefers blue buttons somewhere.", confidence: MIN_MEMORY_CONFIDENCE - 0.01 }),
    false,
  );
});

test("keeps a fact exactly at the confidence threshold", () => {
  assert.equal(
    isWorthRemembering({ content: "Checkout must work on mobile.", confidence: MIN_MEMORY_CONFIDENCE }),
    true,
  );
});

test("treats a non-finite confidence as not memorable", () => {
  assert.equal(isWorthRemembering({ content: "Some real content here.", confidence: Number.NaN }), false);
});

test("filterMemorableFacts keeps only the worthwhile facts", () => {
  const facts = [
    { content: "The product targets freelance designers.", confidence: 0.85 },
    { content: "ok", confidence: 0.9 },
    { content: "Not sure about the pricing page layout.", confidence: 0.2 },
  ];
  const kept = filterMemorableFacts(facts);
  assert.equal(kept.length, 1);
  assert.match(kept[0].content, /freelance designers/);
});

test("isSubstantiveMemoryContent gates trivial role-memory writes (no confidence field)", () => {
  assert.equal(isSubstantiveMemoryContent(""), false);
  assert.equal(isSubstantiveMemoryContent("   "), false);
  assert.equal(isSubstantiveMemoryContent("ok"), false);
  assert.equal(isSubstantiveMemoryContent("The auth flow now uses magic links."), true);
});

test("dedupeFactsByContent collapses near-identical facts, keeping the most confident", () => {
  const deduped = dedupeFactsByContent([
    { content: "Use a dark theme", confidence: 0.7 },
    { content: "use a dark theme.", confidence: 0.9 },
    { content: "The product targets designers", confidence: 0.8 },
  ]);
  assert.equal(deduped.length, 2);
  const dark = deduped.find((f) => /dark theme/i.test(f.content));
  assert.equal(dark?.confidence, 0.9, "the higher-confidence duplicate wins");
});

test("dedupeFactsByContent keeps genuinely distinct facts", () => {
  const facts = [
    { content: "Use a dark theme", confidence: 0.8 },
    { content: "Use a light sidebar", confidence: 0.8 },
  ];
  assert.equal(dedupeFactsByContent(facts).length, 2);
});

test("thresholds are sane", () => {
  assert.ok(MIN_MEMORY_CONFIDENCE > 0 && MIN_MEMORY_CONFIDENCE < 1);
  assert.ok(MIN_MEMORY_CONTENT_CHARS >= 3);
});
