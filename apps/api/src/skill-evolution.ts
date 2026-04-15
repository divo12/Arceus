/**
 * Spec 14 – Phase 2: Skill Evolution LLM Integration
 *
 * This file lives in apps/api because it depends on structuredCompletion
 * (Azure OpenAI) and Zod schemas for response_format. The pure decision
 * logic lives in company-runtime/skill-mutator.ts.
 *
 * Call initSkillEvolution() once at startup to wire the LLM deps.
 */

import { z } from "zod";
import { structuredCompletion } from "./azure-openai";
import { setSkillMutatorDeps } from "@arceus/company-runtime";
import type { TaskOutcomeContext } from "@arceus/company-runtime";
import type { SkillArtifact, FailureAttribution } from "@arceus/contracts";

// ── Zod schemas for LLM structured output ────────────────

const failureAttributionResponseSchema = z.object({
  attributedSkillId: z.string().nullable(),
  failureMode: z.string(),
  confidence: z.number(),
  suggestedFix: z.string(),
  isSkillGap: z.boolean(),
});

const skillMutationResponseSchema = z.object({
  content: z.string().describe("Full skill document body in Markdown (everything AFTER the YAML frontmatter)"),
  trigger: z.string().describe("One-line description used as the skill trigger (same as frontmatter 'description')"),
  description: z.string().describe("One-line summary of what the skill teaches"),
});

const skillDiscoveryResponseSchema = z.object({
  content: z.string().describe("Full skill document body in Markdown (everything AFTER the YAML frontmatter)"),
  trigger: z.string().describe("One-line description used as the skill trigger (same as frontmatter 'description')"),
  name: z.string().describe("Kebab-case skill name (e.g. 'jwt-authentication')"),
  description: z.string().describe("One-line summary of what the skill teaches"),
});

// ── LLM Prompts ──────────────────────────────────────────

function buildAttributionPrompt(ctx: TaskOutcomeContext, skills: SkillArtifact[]): string {
  const skillContext = skills.length > 0
    ? skills.map((s) =>
        `- ID: ${s.id} | ${s.name} (v${s.version}, rate=${s.successRate}): trigger="${s.trigger}"\n  Content preview: ${s.content.slice(0, 300)}...`
      ).join("\n")
    : "No skills were matched for this task.";

  return `Analyze why this task ${ctx.status === "failed" ? "failed" : "required excessive rework (${ctx.iterationCount} iterations)"}.

## Task
- ID: ${ctx.taskId}
- Title: ${ctx.taskTitle}
- Description: ${ctx.taskDescription}
- Role: ${ctx.assignedRole}
- Status: ${ctx.status}
- Iteration count: ${ctx.iterationCount}

## Matched Skills
${skillContext}

## Execution Trace
${ctx.executionTrace || "No trace available."}

## Instructions
Determine if a specific skill caused the problem or if there's a skill gap (no applicable skill exists).
- Set attributedSkillId to the exact skill ID if an existing skill is at fault, or null for a skill gap.
- Set isSkillGap to true only if NO existing skill covers what this task needed.
- Confidence should reflect how sure you are (0.0 = guessing, 1.0 = certain).`;
}

function buildMutationPrompt(skill: SkillArtifact, attribution: FailureAttribution): string {
  return `Rewrite this skill to fix the identified failure.

## Original Skill: ${skill.name} (v${skill.version})
### Trigger
${skill.trigger}

### Full Content
${skill.content}

## Failure Analysis
- Mode: ${attribution.failureMode}
- Suggested Fix: ${attribution.suggestedFix}

## Output Format
Return the skill body as rich Markdown matching this structure:

\`\`\`markdown
# <Skill Title>

## When to use
<One paragraph: when should this skill activate>

## <Numbered sections with domain-specific instructions>
<Detailed, actionable steps. Use tables, code blocks, and bullet points where appropriate.>

## Do's and Don'ts
### Do
- <specific actionable items>

### Don't
- <specific pitfalls to avoid>

## Quick Reference
<Concise cheat-sheet: key values, commands, or patterns for fast lookup>
\`\`\`

## Instructions
- The "content" field must contain ONLY the Markdown body (no YAML frontmatter — that is handled separately).
- Preserve what works from the original skill, fix what caused the failure.
- Be specific and actionable — include exact values, code snippets, file paths, or commands where relevant.
- Match the depth and detail level of the original skill content.
- The "trigger" field is a one-line description of when this skill should activate.
- The "description" field is a one-line summary of what the skill teaches.`;
}

function buildDiscoveryPrompt(attribution: FailureAttribution, role: string): string {
  return `Create a brand-new skill to fill an identified gap for an AI agent.

## Skill Gap
- Failure Mode: ${attribution.failureMode}
- Suggested Approach: ${attribution.suggestedFix}
- For Role: ${role}

## Output Format
Return the skill body as rich Markdown matching this structure:

\`\`\`markdown
# <Skill Title>

## When to use
<One paragraph: when should this skill activate>

## Constraints (NON-NEGOTIABLE)
- <Hard rules the agent must always follow>

## <Numbered sections with domain-specific instructions>
<Detailed, actionable steps. Use tables, code blocks, and bullet points where appropriate.>

## Do's and Don'ts
### Do
- <specific actionable items>

### Don't
- <specific pitfalls to avoid>

## Quick Reference
<Concise cheat-sheet: key values, commands, or patterns for fast lookup>
\`\`\`

## Instructions
- The "content" field must contain ONLY the Markdown body (no YAML frontmatter).
- Be specific and actionable — include exact values, code snippets, file paths, or commands where relevant.
- Write at least 3 substantive sections beyond "When to use".
- The skill should be detailed enough that an AI agent can follow it without additional context.
- The "name" field must be kebab-case (e.g. "jwt-authentication-middleware").
- The "trigger" field is a one-line description of when this skill should activate.
- The "description" field is a one-line summary of what the skill teaches.`;
}

// ── Initialization ───────────────────────────────────────

export function initSkillEvolution(): void {
  setSkillMutatorDeps({
    async analyzeFailure(ctx, matchedSkills) {
      return structuredCompletion(
        "workerDeployment",    // gpt-4o-mini — cheap (~$0.003)
        [
          { role: "system", content: "You are a skill analyst for an AI agent system. Analyze task failures and attribute them to specific skills or identify skill gaps. Return structured JSON." },
          { role: "user", content: buildAttributionPrompt(ctx, matchedSkills) },
        ],
        failureAttributionResponseSchema,
        "failure_attribution",
        { temperature: 0.3 },
        { companyId: ctx.companyId, agentRole: ctx.assignedRole, label: "failure_attribution" },
      );
    },

    async proposeSkillMutation(original, attribution) {
      return structuredCompletion(
        "ceoDeployment",       // gpt-4o — strong (~$0.01)
        [
          { role: "system", content: "You are a skill author for an AI agent system. Rewrite skills to fix identified failures. Return structured JSON." },
          { role: "user", content: buildMutationPrompt(original, attribution) },
        ],
        skillMutationResponseSchema,
        "skill_mutation",
        { temperature: 0.5 },
      );
    },

    async proposeSkillDiscovery(attribution, role) {
      return structuredCompletion(
        "ceoDeployment",       // gpt-4o — strong (~$0.015)
        [
          { role: "system", content: "You are a skill author for an AI agent system. Create new skills to fill identified gaps. Return structured JSON." },
          { role: "user", content: buildDiscoveryPrompt(attribution, role) },
        ],
        skillDiscoveryResponseSchema,
        "skill_discovery",
        { temperature: 0.5 },
      );
    },
  });

  console.log("[SkillEvolution] LLM deps wired for failure attribution + skill mutation");
}
