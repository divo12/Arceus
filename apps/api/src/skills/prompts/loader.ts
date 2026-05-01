/**
 * Prompt template loader.
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

export const ATTRIBUTION_SYSTEM_PROMPT = loadPrompt("attribution");
export const MUTATION_SYSTEM_PROMPT = loadPrompt("mutation");
export const DISCOVERY_SYSTEM_PROMPT = loadPrompt("discovery");
export const TGA_SYSTEM_PROMPT = loadPrompt("tga");
export const EAA_SYSTEM_PROMPT = loadPrompt("eaa");
export const ROA_SYSTEM_PROMPT = loadPrompt("roa");
export const REVISION_SYSTEM_PROMPT = loadPrompt("revision");
export const SYNTHESIS_SYSTEM_PROMPT = loadPrompt("synthesis");
