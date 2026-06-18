/**
 * Assembled-prompt de-duplication. A beat's final prompt concatenates many
 * fragments (role soul + state renders + task-lifecycle procedure + heartbeat +
 * nudges); the same instruction often appears in several of them ("do not invent
 * work", the lifecycle contract). This collapses substantive repeated sentences
 * across fragments — keeping the FIRST occurrence (so the instruction still
 * reaches the model once) — while preserving markdown structure (headers, list
 * bullets, tables, code) and short fragments. Pure → testable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupePromptText, dedupeAssembled } from "./prompt-dedup.js";

test("drops an exact repeated substantive sentence, keeps the first", () => {
  const seen = new Set<string>();
  const a = dedupePromptText("Do not invent work or create placeholder artifacts here.", seen);
  const b = dedupePromptText("Do not invent work or create placeholder artifacts here.", seen);
  assert.match(a, /invent work/);
  assert.equal(b.trim(), "", "the second occurrence is removed");
});

test("normalizes case/punctuation when matching", () => {
  const seen = new Set<string>();
  dedupePromptText("Do not invent work or create placeholder artifacts here.", seen);
  const b = dedupePromptText("DO NOT invent work or create placeholder artifacts here!!!", seen);
  assert.equal(b.trim(), "", "case/punctuation differences still count as a duplicate");
});

test("preserves markdown structure lines even if textually repeated", () => {
  const seen = new Set<string>();
  dedupePromptText("## How to work this beat", seen);
  const again = dedupePromptText("## How to work this beat", seen);
  assert.match(again, /How to work this beat/, "headers are structural, not de-duped away");
});

test("keeps short fragments (too short to be a meaningful instruction)", () => {
  const seen = new Set<string>();
  dedupePromptText("Done.", seen);
  const again = dedupePromptText("Done.", seen);
  assert.match(again, /Done/);
});

test("within a line, drops only the duplicate sentence and keeps the rest", () => {
  const seen = new Set<string>();
  dedupePromptText("Do not invent work or create placeholder artifacts here.", seen);
  const line = dedupePromptText(
    "Do not invent work or create placeholder artifacts here. Always claim before you mutate state.",
    seen,
  );
  assert.doesNotMatch(line, /invent work/);
  assert.match(line, /claim before you mutate/);
});

test("dedupeAssembled seeds from prior text (the role soul) so a verbatim user repeat drops", () => {
  const soul = "Do not invent work or hallucinate task identifiers ever.";
  const out = dedupeAssembled(
    ["## Your Tasks", "Do not invent work or hallucinate task identifiers ever."],
    soul,
  );
  assert.match(out, /Your Tasks/, "structure kept");
  // The user-side verbatim repeat of the soul sentence is gone (model still sees it in the soul).
  assert.doesNotMatch(out.split("Your Tasks")[1] ?? "", /invent work or hallucinate/);
});

test("dedupeAssembled joins sections with the section separator", () => {
  const out = dedupeAssembled(["alpha section unique line one here", "beta section unique line two here"], "");
  assert.match(out, /alpha section/);
  assert.match(out, /beta section/);
  assert.match(out, /\n\n---\n\n/);
});
