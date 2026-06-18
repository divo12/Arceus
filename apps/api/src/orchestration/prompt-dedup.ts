/**
 * Assembled-prompt de-duplication.
 *
 * A beat's final prompt concatenates many fragments — the role soul, per-beat
 * state renders, the task-lifecycle procedure, the heartbeat block, nudges — and
 * the same instruction ("do not invent work", the lifecycle contract, heartbeat
 * guidance) often appears in several of them. Each repeat costs tokens and dilutes
 * the signal.
 *
 * This collapses substantive repeated sentences ACROSS fragments, keeping the
 * FIRST occurrence so every instruction still reaches the model exactly once.
 * It is deliberately conservative:
 *   - structural lines (markdown headers, list bullets, tables, blockquotes,
 *     code fences) are never touched — they carry layout, not repeated prose;
 *   - only substantive sentences (≥ MIN_DUP_CHARS after normalization) are
 *     candidates, so short fragments and labels survive;
 *   - matching normalizes case/punctuation/whitespace so "Do not invent work."
 *     and "DO NOT invent work!" count as the same.
 */

/** Lines that are layout, not repeatable prose — left untouched. */
const STRUCTURAL_LINE = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\||```|---|===)/;

/** Below this normalized length a sentence is too small to be a meaningful duplicate. */
const MIN_DUP_CHARS = 24;

const SECTION_SEPARATOR = "\n\n---\n\n";

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Split a line into sentences, preserving trailing punctuation. */
function splitSentences(line: string): string[] {
  return line.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [line];
}

/**
 * De-duplicate `text` against the `seen` set (mutated): drop any substantive
 * sentence whose normalized form was already seen; record kept ones. Structural
 * lines pass through untouched. A line whose every sentence was a duplicate is
 * dropped entirely.
 */
export function dedupePromptText(text: string, seen = new Set<string>()): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || STRUCTURAL_LINE.test(line)) {
      out.push(line);
      continue;
    }
    const kept = splitSentences(line).filter((sentence) => {
      const key = normalize(sentence);
      if (key.length < MIN_DUP_CHARS) return true; // too short to dedupe
      if (seen.has(key)) return false; // duplicate — drop
      seen.add(key);
      return true;
    });
    if (kept.length === 0) continue; // whole line was duplicate
    out.push(kept.join("").replace(/[ \t]+$/g, ""));
  }
  return out.join("\n");
}

/**
 * Join prompt sections, de-duplicating substantive repeated sentences across
 * them. `priorText` (e.g. the role soul, which the model already sees as the
 * system message) seeds the seen-set so the user-side sections don't restate it.
 */
export function dedupeAssembled(sections: readonly string[], priorText = ""): string {
  const seen = new Set<string>();
  if (priorText) dedupePromptText(priorText, seen); // seed only — output discarded
  return sections.map((s) => dedupePromptText(s, seen)).join(SECTION_SEPARATOR);
}
