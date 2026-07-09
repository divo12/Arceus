/**
 * @arceus/prompts — the single home for all LLM prompt text in Arceus.
 *
 * Domain packages (company-runtime, hippocampus, api) keep their runtime logic
 * but pull the actual prompt strings from here, so prompts live in one place,
 * version independently, and don't drift across copy-pasted inline duplicates.
 *
 * This package is a dependency-free leaf — it holds text + pure loaders only.
 */

// Role souls (per-role system prompts) + shared producer-role discipline rules.
export * from "./roles";

// Memory / fact-extraction system prompts (loaded from colocated .md files).
export * from "./memory/loader";

// Skill-evolution system prompts (attribution, mutation, discovery, TGA, …).
export * from "./skills/loader";

// Internal agents (facilitator meeting synthesis/resolution/brief).
export * from "./internal-agents";
