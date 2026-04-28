/**
 * Memory extraction, action decision, and habit matching — injected into the
 * Hippocampus service singleton.
 *
 * All three surviving primitives are stateless `structuredCompletion` calls
 * with inline phase-specific system prompts. The earlier Memory Agent
 * persistent-session abstraction was deleted (spec 27 §6 / philosophy doc §1):
 * user prompts are self-contained, session continuity was never load-bearing,
 * and information isolation between phases is a design feature.
 *
 * Priming is now purely deterministic via hippocampus's `renderPrimingDisposition`
 * fallback — the old `memoryAgentGeneratePriming` took pre-digested numeric
 * inputs that the LLM couldn't improve on.
 */

import { z } from "zod";
import { structuredCompletion } from "../infra/azure-openai.js";
import {
  createHippocampusService,
  buildExtractionUserPrompt,
  buildActionDecisionUserPrompt,
  HABIT_MATCHER_SYSTEM_PROMPT,
  buildHabitMatcherUserPrompt,
  createPgVectorStores,
} from "@arceus/hippocampus";
import type { ExtractedFact, MemoryAction } from "@arceus/hippocampus";

// ---------------------------------------------------------------------------
// Zod schemas for LLM structured outputs
// ---------------------------------------------------------------------------

export const extractedFactSchema = z.object({
  facts: z.array(z.object({
    content: z.string(),
    type: z.enum(["static", "dynamic", "procedural"]),
    confidence: z.number(),
    is_temporal: z.boolean(),
    expiry_days: z.number().nullable(),
    trigger: z.string().nullable(),
    action: z.string().nullable(),
  })),
});

export const memoryActionSchema = z.object({
  action: z.enum(["ADD", "UPDATE", "DELETE", "NONE"]),
  target_id: z.string().nullable(),
  reason: z.string(),
});

export const habitMatcherSchema = z.object({
  habit_ids: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Inline system prompts (one per primitive — no shared session, by design)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT =
  "You extract structured facts from an agent's task output. Return facts with type " +
  "(static, dynamic, or procedural), a 0-1 confidence score, and temporal markers. " +
  "Respond with JSON matching the requested schema — no prose, no explanation.";

const ACTION_DECISION_SYSTEM_PROMPT =
  "You decide whether a new fact should ADD, UPDATE, DELETE, or be ignored (NONE) " +
  "against a list of existing memories. Explain your reasoning, especially for " +
  "UPDATE and DELETE. Respond with JSON matching the requested schema.";

// ---------------------------------------------------------------------------
// Hippocampus-injected LLM primitives
// ---------------------------------------------------------------------------

/** Extract structured facts from an agent's output. */
export async function memoryAgentExtractFacts(
  agentOutput: string,
  taskTitle: string,
  role: string,
): Promise<ExtractedFact[]> {
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: buildExtractionUserPrompt(taskTitle, role, agentOutput) },
    ],
    extractedFactSchema,
    "memory_fact_extraction",
    { temperature: 0.1 },
  );
  return result.facts
    .filter((f) => !isTrivialFact(f.content))
    .map((f) => ({
      ...f,
      trigger: f.trigger ?? undefined,
      action: f.action ?? undefined,
    }));
}

/**
 * Drop facts that just restate snapshot fields the system already owns
 * (agent role, task kind, task status). The LLM happily emits these for
 * every completed beat, which inflates Hippocampus with noise like
 * "The agent role for the task was CEO" or "The task kind was implementation".
 * Pattern-based so the extraction prompt can stay simple.
 */
const TRIVIAL_FACT_PATTERNS: RegExp[] = [
  /^the agent role (was|is|for the task (was|is)) /i,
  /^the task kind (was|is) /i,
  /^the task status (was|is|is set to|was set to) /i,
  /^the task output status (was|is) /i,
  /^the task (was|is) (created|planned|in_progress|in progress|completed|cancelled|blocked)\.?$/i,
];

function isTrivialFact(content: string): boolean {
  const trimmed = content.trim();
  return TRIVIAL_FACT_PATTERNS.some((rx) => rx.test(trimmed));
}

/** Decide whether to ADD, UPDATE, DELETE, or ignore a fact against existing memories. */
export async function memoryAgentDecideAction(
  newFact: string,
  existingMemories: Array<{ id: string; content: string; type: string; confidence: number }>,
): Promise<MemoryAction> {
  return structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: ACTION_DECISION_SYSTEM_PROMPT },
      { role: "user", content: buildActionDecisionUserPrompt(newFact, existingMemories) },
    ],
    memoryActionSchema,
    "memory_action_decision",
    { temperature: 0.1 },
  );
}

/** Match a task description against known habits and return matching habit IDs. */
export async function llmHabitMatcher(
  taskDescription: string,
  habits: Array<{ id: string; trigger: string; action: string }>,
): Promise<string[]> {
  const userPrompt = buildHabitMatcherUserPrompt(taskDescription, habits as any);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: HABIT_MATCHER_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    habitMatcherSchema,
    "habit_matching",
    { temperature: 0.1 },
  );
  // Only return IDs that actually exist in the input list
  const validIds = new Set(habits.map((h) => h.id));
  return result.habit_ids.filter((id) => validIds.has(id));
}

// ---------------------------------------------------------------------------
// Hippocampus service singleton
// ---------------------------------------------------------------------------

const pgStores = createPgVectorStores();
if (pgStores) {
  console.log("[Hippocampus] Using pgvector-backed persistent stores");
} else {
  console.log("[Hippocampus] Database not configured — using in-memory stores (memories lost on restart)");
}

/** Singleton Hippocampus service wired to Memory Agent extractors and pgvector stores. */
export const hippocampus = createHippocampusService({
  ...pgStores,
  extractFacts: memoryAgentExtractFacts,
  decideAction: memoryAgentDecideAction,
  matchHabits: llmHabitMatcher,
});
