/**
 * LLM-based habit trigger evaluation.
 *
 * Given a task description and the agent's active habits, the LLM decides
 * which habits are relevant to the current task. Replaces naive token matching.
 *
 * The actual LLM call is injected via HabitMatcher so the hippocampus
 * package stays decoupled from the API layer.
 */

import type { Habit } from "@arceus/contracts";
export { HABIT_MATCHER_SYSTEM_PROMPT } from "./prompts/loader.js";

/**
 * Build the user-side prompt listing the task description and all candidate habits
 * for the LLM to evaluate trigger relevance.
 */
export function buildHabitMatcherUserPrompt(
  taskDescription: string,
  habits: Habit[],
): string {
  if (habits.length === 0) return `TASK: ${taskDescription}\n\nHABITS: (none)`;

  const habitList = habits
    .map((h) => `  - [${h.id}] trigger: "${h.trigger}" → action: "${h.action}"`)
    .join("\n");

  return [
    `TASK: ${taskDescription}`,
    "",
    "HABITS:",
    habitList,
  ].join("\n");
}
