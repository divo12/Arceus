/**
 * LLM action decision for memory deduplication and contradiction handling.
 *
 * For each extracted fact, the LLM compares it against existing similar memories
 * and decides: ADD (new), UPDATE (refines existing), DELETE (contradicts), or NONE (already known).
 *
 * The actual LLM call is injected via ActionDecider so the hippocampus
 * package stays decoupled from the API layer.
 */

import type { MemoryUnit } from "@arceus/contracts";
export { ACTION_DECISION_SYSTEM_PROMPT } from "@arceus/prompts";

/**
 * Build the user-side prompt for action decision, presenting the new fact
 * alongside existing similar memories for comparison.
 */
export function buildActionDecisionUserPrompt(
  newFact: string,
  existingMemories: { id: string; content: string; type: string; confidence: number }[],
): string {
  const memoryList = existingMemories.length === 0
    ? "(No existing memories found)"
    : existingMemories
        .map((m, i) => `  ${i + 1}. [${m.id}] (${m.type}, confidence: ${m.confidence}) ${m.content}`)
        .join("\n");

  return [
    "NEW FACT:",
    `  ${newFact}`,
    "",
    "EXISTING MEMORIES (most similar first):",
    memoryList,
  ].join("\n");
}
