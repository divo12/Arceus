import { z } from "zod";
import { getSnapshot } from "../persistence/store.js";
import { structuredCompletion } from "../infra/azure-openai.js";
import { recordSkillUsage } from "@arceus/company-runtime";
import { buildSkillCatalog } from "./catalog.js";

/**
 * Zod schema for the classifier's structured output.
 * Kept tiny — 0-3 skill IDs plus a short justification for audit.
 */
export const skillClassifierSchema = z.object({
  appliedSkillIds: z
    .array(z.string())
    .max(3)
    .describe("IDs of 0-3 skills from the catalog that most apply to this task."),
  reasoning: z
    .string()
    .max(240)
    .describe("One short sentence explaining why these skills (or none) apply."),
});

/**
 * Classify which skills apply to a task using a cheap LLM call.
 *
 * Progressive disclosure, tier-1: the LLM is given a compact catalog of
 * all role skills and picks 0-3 IDs. This replaces the former
 * embedding-cosine matcher — the LLM's language understanding does the
 * matching, no precomputed embeddings needed.
 *
 * Falls back to an empty list on failure (skills still available but not
 * pre-applied — the agent can still read the catalog via buildSkillSection
 * when `matchedSkillIds` is undefined at the call site).
 */
export async function classifyTaskSkills(
  role: string,
  taskDescription: string,
  catalog: ReturnType<typeof buildSkillCatalog>,
): Promise<string[]> {
  if (catalog.length === 0) return [];

  const catalogText = catalog
    .map(
      (s) =>
        `- ${s.id} [${s.name} v${s.version}] — ${s.trigger} (success ${Math.round(s.successRate * 100)}%)`,
    )
    .join("\n");

  const messages = [
    {
      role: "system" as const,
      content:
        `You select procedural skills for an agent with role "${role}". ` +
        `From the catalog, pick 0-3 skill IDs most relevant to the task. ` +
        `If none apply, return an empty array. Prefer higher success rates ` +
        `when relevance is tied. Return only IDs that appear in the catalog.`,
    },
    {
      role: "user" as const,
      content:
        `## Available skills for role "${role}"\n${catalogText}\n\n` +
        `## Task\n${taskDescription}\n\n` +
        `Return 0-3 skill IDs from the catalog.`,
    },
  ];

  try {
    const result = await structuredCompletion(
      "workerDeployment",
      messages,
      skillClassifierSchema,
      "skill_classifier",
      { temperature: 0.1 },
      {
        companyId: getSnapshot().company.id,
        agentRole: role,
        label: "skill_classifier",
      },
    );
    // Drop hallucinated IDs — keep only those that exist in the catalog.
    const validIds = new Set(catalog.map((s) => s.id));
    return result.appliedSkillIds.filter((id) => validIds.has(id));
  } catch (err) {
    console.warn(
      `[SkillClassifier] ${role} classifier failed, no skills applied: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/**
 * Classify skills applicable to a task and record usage.
 *
 * Tier-1 pre-call: build compact catalog → ask LLM to pick ≤3 IDs → record
 * usage for each picked ID → return IDs. The caller threads these IDs into
 * runPromptText() so buildSkillSection() can render the full bodies (tier-2)
 * in the agent's system prompt.
 */
export async function matchAndRecordSkills(role: string, taskDescription: string): Promise<string[]> {
  const catalog = buildSkillCatalog(role);
  if (catalog.length === 0) return [];
  const picked = await classifyTaskSkills(role, taskDescription, catalog);
  for (const id of picked) {
    recordSkillUsage(id);
  }
  return picked;
}
