/**
 * Spec 14 – Skill Evolution LLM Integration (Phase 2 + Phase 3)
 *
 * This file lives in apps/api because it depends on structuredCompletion
 * (Azure OpenAI) and Zod schemas for response_format. The pure decision
 * logic lives in company-runtime/skill-mutator.ts and skill-tester.ts.
 *
 * Call initSkillEvolution() once at startup to wire all LLM deps.
 */

import { z } from "zod";
import { structuredCompletion } from "./azure-openai";
import { embed as embedWithSentenceTransformers } from "@arceus/hippocampus";
import {
  setSkillMutatorDeps,
  setSkillTesterDeps,
  setPatternLearnerDeps,
  setSkillRegistryDeps,
  storeSkillEmbedding,
} from "@arceus/company-runtime";
import type { TaskOutcomeContext } from "@arceus/company-runtime";
import type {
  SkillArtifact,
  FailureAttribution,
  SkillMutation,
  ATATestScenario,
  SkillCandidate,
} from "@arceus/contracts";

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

// ── Phase 3: ATA Pipeline Zod schemas ───────────────────

const tgaTestScenarioSchema = z.object({
  scenarios: z.array(z.object({
    id: z.string(),
    scenario: z.string(),
    taskPrompt: z.string(),
    expectedOutcomes: z.array(z.string()),
    edgeCases: z.array(z.string()),
  })),
});

const eaaDryRunSchema = z.object({
  testId: z.string(),
  agentPlan: z.string().describe("Step-by-step plan the agent would follow using this skill"),
  outcomeMatches: z.array(z.boolean()).describe("For each expectedOutcome, true if the plan would achieve it"),
  edgeCaseMatches: z.array(z.boolean()).describe("For each edgeCase, true if the plan handles it"),
  notes: z.string().describe("Brief assessment of how well the skill guides the agent"),
});

const roaVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject", "revise"]),
  overallScore: z.number().describe("0.0-1.0 overall quality score"),
  fixesOriginalFailure: z.boolean(),
  coreOutcomesPassing: z.string().describe("e.g. '4/5' — how many core outcomes pass"),
  edgeCasesPassing: z.string().describe("e.g. '2/3' — how many edge cases pass"),
  securityConcerns: z.array(z.string()),
  revisionGuidance: z.string().nullable().describe("Specific feedback for revision, null if approve/reject"),
});

const skillRevisionSchema = z.object({
  content: z.string().describe("Revised skill body in Markdown"),
  trigger: z.string().describe("Updated trigger description"),
  description: z.string().describe("Updated one-line summary"),
});

// ── Phase 5: Pattern Learning Zod schemas ───────────────

const skillSynthesisResponseSchema = z.object({
  name: z.string().describe("Kebab-case skill name (e.g. 'handle-login-button')"),
  trigger: z.string().describe("One-line activation description"),
  content: z.string().describe("Full skill Markdown body (no YAML frontmatter)"),
  description: z.string().describe("One-line summary of what the skill teaches"),
});

// ── Phase 3: ATA Pipeline Prompts ───────────────────────

function buildTGAPrompt(mutation: SkillMutation): string {
  const original = mutation.originalSkillId
    ? `\n## Original Skill\nID: ${mutation.originalSkillId}\nThis is a mutation of an existing skill.`
    : "\n## Note\nThis is a newly discovered skill (no original).";

  return `Generate 3-5 test scenarios to validate this proposed skill.

## Proposed Skill: ${mutation.proposedSkill.name} (v${mutation.proposedSkill.version})
### Trigger
${mutation.proposedSkill.trigger}

### Content
${mutation.proposedSkill.content}
${original}

## Mutation Context
- Reason: ${mutation.reason}
- Failure trace: ${mutation.failureTraceId ?? "none"}

## Instructions
Create test scenarios that:
1. Test the happy path — does the skill guide an agent to complete the task correctly?
2. Test edge cases — what could go wrong?
3. Test the specific failure that triggered this mutation — does the fix actually work?
4. Each scenario should have a realistic taskPrompt an agent would receive.
5. Each scenario should have 2-4 concrete expectedOutcomes (verifiable steps the agent should take).
6. Each scenario should have 1-2 edgeCases (unusual situations the skill should handle).
7. Generate unique IDs like "test-1", "test-2", etc.`;
}

function buildEAAPrompt(skill: SkillArtifact, scenario: ATATestScenario): string {
  return `You are an AI agent with the following skill loaded into your context. Describe what you would do for the given task.

## Your Skill: ${skill.name}
${skill.content}

## Task
${scenario.taskPrompt}

## Instructions
1. Describe your step-by-step plan to complete this task, referencing specific steps from the skill.
2. For each expected outcome below, your plan should achieve it.
3. For each edge case below, your plan should handle it.

### Expected Outcomes
${scenario.expectedOutcomes.map((o, i) => `${i + 1}. ${o}`).join("\n")}

### Edge Cases
${scenario.edgeCases.map((e, i) => `${i + 1}. ${e}`).join("\n")}

## Response Format
- agentPlan: Your detailed step-by-step plan
- outcomeMatches: For each expected outcome (in order), true if your plan achieves it
- edgeCaseMatches: For each edge case (in order), true if your plan handles it
- notes: Brief self-assessment of how well the skill guided you`;
}

function buildROAPrompt(
  mutation: SkillMutation,
  scenarios: ATATestScenario[],
  results: { testId: string; agentPlan: string; outcomeMatches: boolean[]; edgeCaseMatches: boolean[]; notes: string }[],
): string {
  const scenarioResults = scenarios.map((s, i) => {
    const r = results[i];
    const outcomePass = r.outcomeMatches.filter(Boolean).length;
    const edgePass = r.edgeCaseMatches.filter(Boolean).length;
    return `### Scenario: ${s.scenario}
Task: ${s.taskPrompt}
Agent Plan: ${r.agentPlan.slice(0, 500)}${r.agentPlan.length > 500 ? "..." : ""}
Outcomes: ${outcomePass}/${s.expectedOutcomes.length} passing
Edge Cases: ${edgePass}/${s.edgeCases.length} passing
Notes: ${r.notes}`;
  }).join("\n\n");

  return `Evaluate whether this skill mutation should be approved, rejected, or revised.

## Mutation: ${mutation.proposedSkill.name} (v${mutation.proposedSkill.version})
Reason: ${mutation.reason}
Revision cycle: ${mutation.revisionCycle}

## Test Results
${scenarioResults}

## Evaluation Criteria (all required for approve)
1. Does the mutation fix the original failure described in the reason?
2. Do all core outcomes pass across scenarios?
3. Is the skill content clear, specific, and actionable?
4. Are there any security risks in the skill's instructions?

## Edge cases are nice-to-have, not blocking.

## Verdict Rules
- "approve": All required criteria met, score >= 0.7
- "revise": Promising but needs specific improvements (provide revisionGuidance)
- "reject": Fundamentally flawed or doesn't fix the original failure`;
}

function buildSkillSynthesisPrompt(candidate: SkillCandidate): string {
  const memberLines = candidate.memberSummaries
    .slice(0, 10)
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n");

  return `An AI agent for the role "${candidate.role}" has repeatedly completed a similar kind of task. Distill the shared intent into a reusable skill.

## Recurring Behavior
- Representative task: ${candidate.representativeTitle}
- Summary: ${candidate.representativeSummary}
- Cluster size: ${candidate.memberCount} related trajectories
- Combined success rate: ${(candidate.combinedSuccessRate * 100).toFixed(0)}%

## Trajectory Samples
${memberLines}

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
- The "name" must be kebab-case and reflect the shared intent (e.g. "add-supabase-auth-button").
- The "trigger" is a one-line activation description (what task shape fires this skill).
- The "content" field must contain ONLY the Markdown body (no YAML frontmatter).
- The "description" field is a one-line summary of what the skill teaches.
- Write at least 3 substantive sections beyond "When to use".
- Be specific and actionable — include exact values, code snippets, file paths, or commands where relevant.
- Capture the *pattern* you've seen, not a single task. The skill must generalize to new instances of this task shape.`;
}

function buildRevisionPrompt(mutation: SkillMutation, feedback: string): string {
  return `Revise this skill based on reviewer feedback.

## Current Skill: ${mutation.proposedSkill.name} (v${mutation.proposedSkill.version})
### Trigger
${mutation.proposedSkill.trigger}

### Content
${mutation.proposedSkill.content}

## Original Mutation Reason
${mutation.reason}

## Reviewer Feedback (MUST address)
${feedback}

## Revision Cycle: ${mutation.revisionCycle + 1} of 2

## Instructions
- Address ALL points in the reviewer feedback.
- Preserve what already works.
- The "content" field must be the full Markdown body (no YAML frontmatter).
- Be specific: include exact values, code snippets, commands where relevant.`;
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

  // ── Phase 3: ATA Pipeline deps ─────────────────────────

  setSkillTesterDeps({
    async generateTestScenarios(mutation) {
      const result = await structuredCompletion(
        "workerDeployment",    // gpt-4o-mini — cheap (~$0.005)
        [
          { role: "system", content: "You are a test engineer for an AI agent skill system. Generate test scenarios to validate proposed skills. Return structured JSON." },
          { role: "user", content: buildTGAPrompt(mutation) },
        ],
        tgaTestScenarioSchema,
        "ata_tga",
        { temperature: 0.4 },
      );
      return result.scenarios;
    },

    async executeDryRun(skill, scenario) {
      return structuredCompletion(
        "ceoDeployment",       // gpt-4o — strong (~$0.02 per scenario)
        [
          { role: "system", content: "You are an AI agent executing a task. You have a skill loaded in your context. Describe what you would do step-by-step. Return structured JSON." },
          { role: "user", content: buildEAAPrompt(skill, scenario) },
        ],
        eaaDryRunSchema,
        "ata_eaa",
        { temperature: 0.3 },
      );
    },

    async reviewResults(mutation, scenarios, results) {
      return structuredCompletion(
        "workerDeployment",    // gpt-4o-mini — cheap (~$0.004)
        [
          { role: "system", content: "You are a senior reviewer evaluating whether a proposed skill mutation should go live. Be strict but fair. Return structured JSON." },
          { role: "user", content: buildROAPrompt(mutation, scenarios, results) },
        ],
        roaVerdictSchema,
        "ata_roa",
        { temperature: 0.2 },
      );
    },

    async reviseSkill(mutation, feedback) {
      return structuredCompletion(
        "ceoDeployment",       // gpt-4o — strong
        [
          { role: "system", content: "You are a skill author revising a skill based on reviewer feedback. Return structured JSON." },
          { role: "user", content: buildRevisionPrompt(mutation, feedback) },
        ],
        skillRevisionSchema,
        "ata_revision",
        { temperature: 0.5 },
      );
    },
  });

  console.log("[SkillEvolution] ATA pipeline deps wired (TGA + EAA + ROA)");

  // ── Phase 5: Pattern Learning deps ─────────────────────

  setPatternLearnerDeps({
    async embedText(text: string) {
      // Uses the same local sentence-transformers model (all-MiniLM-L6-v2, 384-dim)
      // that powers Hippocampus — no Azure calls, no per-task LLM cost.
      return embedWithSentenceTransformers(text);
    },

    async synthesizeSkill(candidate) {
      return structuredCompletion(
        "ceoDeployment",       // gpt-4o — strong (~$0.015)
        [
          { role: "system", content: "You are a skill author for an AI agent system. Distill recurring agent behaviors into reusable skills. Return structured JSON." },
          { role: "user", content: buildSkillSynthesisPrompt(candidate) },
        ],
        skillSynthesisResponseSchema,
        "pattern_synthesis",
        { temperature: 0.4 },
        { companyId: candidate.companyId, agentRole: candidate.role, label: "pattern_synthesis" },
      );
    },
  });

  console.log("[SkillEvolution] Pattern learner deps wired (embeddings + synthesis)");

  // ── Skill Registry: semantic matching deps ─────────────
  // Reuses the same local sentence-transformers model.
  // After this is wired, matchSkillsAsync() scores by cosine similarity
  // against stored triggerEmbeddings instead of token overlap.

  setSkillRegistryDeps({
    async embedText(text: string) {
      return embedWithSentenceTransformers(text);
    },
    onSkillActivated(skill) {
      // Fire-and-forget: embed the trigger so future matchSkillsAsync calls
      // can use cosine similarity for this skill immediately.
      embedWithSentenceTransformers(skill.trigger)
        .then((embedding) => storeSkillEmbedding(skill.id, embedding))
        .catch((err) => {
          console.warn(`[SkillRegistry] Failed to embed trigger for ${skill.id}: ${err instanceof Error ? err.message : err}`);
        });
    },
  });

  console.log("[SkillEvolution] Skill registry semantic matching wired (cosine via all-MiniLM-L6-v2)");
}
