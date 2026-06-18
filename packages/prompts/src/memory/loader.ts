/**
 * Prompt template loader for hippocampus engines.
 * Spec 34 v3 PR 15.
 *
 * Reads `prompts/*.md` once at module init via fs.readFileSync. Trailing
 * newline is stripped so the prompt body is byte-identical to the inline
 * string it replaces.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8").trimEnd();
}

export const ACTION_DECISION_SYSTEM_PROMPT = loadPrompt("action-decision");
export const HABIT_MATCHER_SYSTEM_PROMPT = loadPrompt("habit-matcher");
export const EXTRACTION_SYSTEM_PROMPT = loadPrompt("extraction");
export const MEETING_EXTRACTION_PROMPT = loadPrompt("meeting-extraction");
