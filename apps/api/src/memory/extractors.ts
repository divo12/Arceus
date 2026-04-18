import { z } from "zod";
import { structuredCompletion } from "../infra/azure-openai.js";
import {
  createHippocampusService,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  ACTION_DECISION_SYSTEM_PROMPT,
  buildActionDecisionUserPrompt,
  HABIT_MATCHER_SYSTEM_PROMPT,
  buildHabitMatcherUserPrompt,
  PRIMING_GENERATOR_SYSTEM_PROMPT,
  buildPrimingGeneratorUserPrompt,
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

export const primingDispositionSchema = z.object({
  disposition: z.string(),
});

export const habitMatcherSchema = z.object({
  habit_ids: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// LLM-backed extractors / deciders
// ---------------------------------------------------------------------------

export async function llmFactExtractor(agentOutput: string, taskTitle: string, role: string): Promise<ExtractedFact[]> {
  const userPrompt = buildExtractionUserPrompt(taskTitle, role, agentOutput);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    extractedFactSchema,
    "fact_extraction",
    { temperature: 0.3 },
  );
  return result.facts.map((f) => ({
    ...f,
    trigger: f.trigger ?? undefined,
    action: f.action ?? undefined,
  }));
}

export async function llmActionDecider(
  newFact: string,
  existingMemories: Array<{ id: string; content: string; type: string; confidence: number }>,
): Promise<MemoryAction> {
  const userPrompt = buildActionDecisionUserPrompt(newFact, existingMemories);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: ACTION_DECISION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    memoryActionSchema,
    "memory_action_decision",
    { temperature: 0.1 },
  );
  return result;
}

export async function llmPrimingGenerator(
  state: { confidence: number; caution: number; morale: number; recentEvents: string[] },
): Promise<string> {
  const userPrompt = buildPrimingGeneratorUserPrompt(state as any);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: PRIMING_GENERATOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    primingDispositionSchema,
    "priming_generation",
    { temperature: 0.4 },
  );
  return result.disposition;
}

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

export const hippocampus = createHippocampusService({
  ...pgStores,
  extractFacts: llmFactExtractor,
  decideAction: llmActionDecider,
  matchHabits: llmHabitMatcher,
  generatePriming: llmPrimingGenerator,
});
