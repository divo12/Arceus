import { z } from "zod";

/**
 * Zod schema for the (retired) classifier's structured output.
 * Kept exported in case downstream callers still reference the type;
 * the matching functions were deleted in Spec 28 Phase C.2 — progressive
 * disclosure via beat-context-builder.ts handles skill selection now.
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
