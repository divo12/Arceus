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

export const HABIT_MATCHER_SYSTEM_PROMPT = `You are evaluating which behavioral habits apply to a given task.

You will receive a task description and a list of habits the agent has learned. Each habit has an ID, a trigger condition, and an action.

Return ONLY the IDs of habits whose trigger conditions are relevant to the given task. A habit is relevant if the task is likely to involve the situation described in the trigger.

Rules:
- Be selective — only return habits that genuinely apply
- A habit about "API routes" applies to tasks involving endpoints, but NOT to pure CSS tasks
- A habit about "database migrations" applies to schema changes, but NOT to frontend work
- Return an empty array if no habits apply
- Never invent habit IDs — only return IDs from the provided list`;

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
