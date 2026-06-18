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
  EXTRACTION_SYSTEM_PROMPT,
  ACTION_DECISION_SYSTEM_PROMPT,
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

/**
 * Schema for the BATCHED action-decider response. The LLM receives N facts
 * and returns N decisions in the same order. We validate length matches at
 * the call site so a drifting LLM that drops/adds entries fails loudly
 * instead of silently misaligning facts to decisions.
 */
export const memoryActionsBatchSchema = z.object({
  decisions: z.array(memoryActionSchema),
});

export const habitMatcherSchema = z.object({
  habit_ids: z.array(z.string()),
});

// System prompts (EXTRACTION_SYSTEM_PROMPT, ACTION_DECISION_SYSTEM_PROMPT,
// HABIT_MATCHER_SYSTEM_PROMPT) are the canonical ones from @arceus/prompts,
// re-exported via @arceus/hippocampus — no inline duplicates here.

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
    "memoryDeployment",
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
  existingMemories: { id: string; content: string; type: string; confidence: number }[],
): Promise<MemoryAction> {
  return structuredCompletion(
    "memoryDeployment",
    [
      { role: "system", content: ACTION_DECISION_SYSTEM_PROMPT },
      { role: "user", content: buildActionDecisionUserPrompt(newFact, existingMemories) },
    ],
    memoryActionSchema,
    "memory_action_decision",
    { temperature: 0.1 },
  );
}

const BATCH_DECISION_SYSTEM_PROMPT = [
  ACTION_DECISION_SYSTEM_PROMPT,
  "",
  "BATCH MODE: You will receive N facts, each paired with its own list of",
  "existing similar memories. Return EXACTLY N decisions in the SAME ORDER",
  "as the input facts — index 0 of `decisions` corresponds to the first fact,",
  "index 1 to the second, and so on. Do not reorder, drop, or merge entries.",
].join("\n");

function buildBatchedActionDecisionUserPrompt(
  items: { newFact: string; existingMemories: { id: string; content: string; type: string; confidence: number }[] }[],
): string {
  const lines = [
    `Decide an action for each of the ${items.length} facts below.`,
    "Return one decision per fact, in order.",
    "",
  ];
  items.forEach((item, idx) => {
    lines.push(`--- FACT ${idx + 1} ---`);
    lines.push(buildActionDecisionUserPrompt(item.newFact, item.existingMemories));
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Batched variant of `memoryAgentDecideAction` — collapses N per-fact LLM
 * calls into ONE call per task. Returns decisions in the same order as the
 * input items. Caller is responsible for verifying length matches; the
 * service layer treats a length mismatch as a batch failure and falls
 * back to ADD for the affected facts.
 */
export async function memoryAgentDecideActionsBatch(
  items: { newFact: string; existingMemories: { id: string; content: string; type: string; confidence: number }[] }[],
): Promise<MemoryAction[]> {
  if (items.length === 0) return [];
  const result = await structuredCompletion(
    "memoryDeployment",
    [
      { role: "system", content: BATCH_DECISION_SYSTEM_PROMPT },
      { role: "user", content: buildBatchedActionDecisionUserPrompt(items) },
    ],
    memoryActionsBatchSchema,
    "memory_action_decisions_batch",
    { temperature: 0.1 },
  );
  return result.decisions;
}

/** Match a task description against known habits and return matching habit IDs. */
export async function llmHabitMatcher(
  taskDescription: string,
  habits: { id: string; trigger: string; action: string }[],
): Promise<string[]> {
  const userPrompt = buildHabitMatcherUserPrompt(taskDescription, habits as Parameters<typeof buildHabitMatcherUserPrompt>[1]);
  const result = await structuredCompletion(
    "memoryDeployment",
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
  decideActionsBatch: memoryAgentDecideActionsBatch,
  matchHabits: llmHabitMatcher,
});
