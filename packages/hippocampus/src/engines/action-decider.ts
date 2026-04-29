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

export const ACTION_DECISION_SYSTEM_PROMPT = `You are a memory management system for an AI software company.

Given a NEW fact extracted from a completed task and a list of EXISTING memories for the same agent, decide what action to take.

Actions:
- ADD: The fact is genuinely new — no existing memory captures it. Store it.
- UPDATE: The fact refines, corrects, or supersedes an existing memory. Specify which memory to update by its id.
- DELETE: The fact directly contradicts an existing memory, making it invalid. Specify which memory to delete by its id.
- NONE: The fact is already captured by an existing memory, or is too trivial to store. Skip it.

Rules:
- Prefer UPDATE over ADD when the fact is a more specific version of something already known
- Prefer NONE over ADD when existing memories already cover the same information
- Only use DELETE when there is a clear contradiction (e.g. "uses Express" vs existing "uses Fastify")
- When in doubt between ADD and NONE, lean toward NONE — avoid memory bloat
- Return exactly one action per decision`;

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
