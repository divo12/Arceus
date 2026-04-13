import type { PrimingState } from "@arceus/contracts";

// ---------------------------------------------------------------------------
// LLM Call Site #2 — Priming Disposition Generator
// ---------------------------------------------------------------------------

export const PRIMING_GENERATOR_SYSTEM_PROMPT = `You generate a one-line behavioral disposition for an AI agent based on its emotional state.

You receive:
- confidence (0-1): how certain the agent is about its abilities
- caution (0-1): how careful the agent should be
- morale (0-1): how positive the agent's recent track record is
- recentEvents: list of recent task outcomes

Return a single natural-language sentence that:
1. Captures the agent's current emotional/behavioral state
2. Gives a concrete behavioral instruction (not vague advice)
3. Stays under 30 words

Examples:
- "Riding a success streak — move fast and trust your instincts, but double-check edge cases."
- "Recent failures suggest caution — verify assumptions before committing and prefer incremental changes."
- "Mixed results lately — start with the safest approach, then iterate if it works."
- "Fresh start with no history — take a balanced first pass without overthinking."

Do NOT:
- Use bullet points or lists
- Mention the numeric scores directly
- Be generic ("do your best") — be specific about approach`;

export function buildPrimingGeneratorUserPrompt(state: PrimingState): string {
  const lines = [
    `confidence: ${state.confidence.toFixed(2)}`,
    `caution: ${state.caution.toFixed(2)}`,
    `morale: ${state.morale.toFixed(2)}`,
    `recent_events: ${state.recentEvents.length > 0 ? state.recentEvents.slice(-5).join(", ") : "none"}`,
  ];
  return lines.join("\n");
}
