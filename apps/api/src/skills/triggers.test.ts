/**
 * Spec 29 Phase G + H — pure helper smoke tests.
 *
 * The DB-backed helpers (maybeEnqueueEvolveJob, runCronTriggerSweep,
 * runRollbackMonitor) are exercised end-to-end in the integration suite
 * once Spec 31 schema is applied; here we cover the format helpers only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmaFromSummary, embedEmaInSummary, EMA_BASELINE_DEFAULT } from "./triggers.js";

test("parseEmaFromSummary returns null when no marker", () => {
  assert.equal(parseEmaFromSummary(null), null);
  assert.equal(parseEmaFromSummary(""), null);
  assert.equal(parseEmaFromSummary("just a normal summary"), null);
});

test("parseEmaFromSummary extracts trailing [ema=N.NN] marker", () => {
  assert.equal(parseEmaFromSummary("Updated for clarity [ema=0.85]"), 0.85);
  assert.equal(parseEmaFromSummary("[ema=0.5]"), 0.5);
});

test("embedEmaInSummary appends marker when there is room", () => {
  const out = embedEmaInSummary("hello", 0.73);
  assert.equal(out, "hello [ema=0.73]");
});

test("embedEmaInSummary truncates user portion when over 280 chars", () => {
  const long = "x".repeat(280);
  const out = embedEmaInSummary(long, 0.5);
  assert.ok(out.length <= 280);
  assert.ok(out.endsWith("[ema=0.50]"));
});

test("EMA_BASELINE_DEFAULT is 0.7 per spec §G.3", () => {
  assert.equal(EMA_BASELINE_DEFAULT, 0.7);
});
