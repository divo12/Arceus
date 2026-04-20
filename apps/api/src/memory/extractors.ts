/**
 * Memory extraction, action decision, priming, and habit matching via LLM agents.
 * Provides the Hippocampus service singleton wired to Memory Agent prompts.
 */

import { z } from "zod";
import { structuredCompletion } from "../infra/azure-openai.js";
import {
  createHippocampusService,
  buildExtractionUserPrompt,
  buildActionDecisionUserPrompt,
  HABIT_MATCHER_SYSTEM_PROMPT,
  buildHabitMatcherUserPrompt,
  buildPrimingGeneratorUserPrompt,
  createPgVectorStores,
} from "@arceus/hippocampus";
import type { ExtractedFact, MemoryAction } from "@arceus/hippocampus";
import { runInternalAgentPrompt } from "../prompts/internal-agent.js";

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
// Memory Agent–backed extractors / deciders (Spec 24 Phase 3)
// All three share the same Memory Agent session for context continuity.
// ---------------------------------------------------------------------------

/** Extract structured facts from an agent's output via the Memory Agent. */
export async function memoryAgentExtractFacts(agentOutput: string, taskTitle: string, role: string): Promise<ExtractedFact[]> {
  const userPrompt = [
    "Phase 1 — EXTRACT. Respond with JSON matching this schema: { facts: [{ content, type, confidence, is_temporal, expiry_days, trigger, action }] }",
    "",
    buildExtractionUserPrompt(taskTitle, role, agentOutput),
  ].join("\n");

  const output = await runInternalAgentPrompt("memory_agent", null, userPrompt);
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Memory Agent extraction returned no JSON");
  const parsed = extractedFactSchema.parse(JSON.parse(jsonMatch[0]));
  return parsed.facts.map((f) => ({
    ...f,
    trigger: f.trigger ?? undefined,
    action: f.action ?? undefined,
  }));
}

/** Decide whether to ADD, UPDATE, DELETE, or ignore a fact against existing memories. */
export async function memoryAgentDecideAction(
  newFact: string,
  existingMemories: Array<{ id: string; content: string; type: string; confidence: number }>,
): Promise<MemoryAction> {
  const userPrompt = [
    "Phase 2 — DECIDE. Respond with JSON: { action, target_id, reason }",
    "",
    buildActionDecisionUserPrompt(newFact, existingMemories),
  ].join("\n");

  const output = await runInternalAgentPrompt("memory_agent", null, userPrompt);
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Memory Agent action decision returned no JSON");
  return memoryActionSchema.parse(JSON.parse(jsonMatch[0]));
}

/** Generate a priming disposition string from agent emotional/confidence state. */
export async function memoryAgentGeneratePriming(
  state: { confidence: number; caution: number; morale: number; recentEvents: string[] },
): Promise<string> {
  const userPrompt = [
    "Phase 3 — PRIME. Respond with JSON: { disposition }",
    "",
    buildPrimingGeneratorUserPrompt(state as any),
  ].join("\n");

  const output = await runInternalAgentPrompt("memory_agent", null, userPrompt);
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Memory Agent priming returned no JSON");
  return primingDispositionSchema.parse(JSON.parse(jsonMatch[0])).disposition;
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
  generatePriming: memoryAgentGeneratePriming,
});
