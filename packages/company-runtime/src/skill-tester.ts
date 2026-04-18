/**
 * Spec 14 – Phase 3: ATA Pipeline (Automated Testing & Approval)
 *
 * Pure logic layer for the 3-agent verification gate.
 * LLM calls are injected via SkillTesterDeps — this module never
 * imports azure-openai, Zod, or structuredCompletion.
 *
 * Architecture:
 *   company-runtime/skill-tester.ts  → orchestrates TGA → EAA → ROA, handles revision loops
 *   apps/api/skill-evolution.ts      → provides HOW (LLM calls, Zod schemas)
 *
 * Pipeline flow:
 *   1. TGA generates 3-5 test scenarios from the mutation context
 *   2. EAA dry-runs each scenario against the proposed skill
 *   3. ROA reviews all results → verdict: approve | reject | revise
 *   4. On "revise" + revisionCycle < 2 → revise skill → re-run pipeline
 *   5. On "approve" → deprecate old skill, activate new, status="merged"
 *   6. On "reject" (or max revisions) → status="rejected"
 */

import type {
  SkillArtifact,
  SkillMutation,
  ATATestScenario,
  ATADryRunResult,
  ATAReviewVerdict,
  ATAPipelineResult,
} from "@arceus/contracts";
import {
  getMutationById,
  updateMutationStatus,
  applyMergedMutation,
  getSkillById,
  storeMutation,
} from "./skill-registry";

// ── Dependency injection ─────────────────────────────────

export interface SkillTesterDeps {
  /** TGA: Generate 3-5 test scenarios for a mutation. */
  generateTestScenarios(mutation: SkillMutation): Promise<ATATestScenario[]>;

  /** EAA: Dry-run a single scenario against the proposed skill. */
  executeDryRun(skill: SkillArtifact, scenario: ATATestScenario): Promise<ATADryRunResult>;

  /** ROA: Review all dry-run results and produce a verdict. */
  reviewResults(
    mutation: SkillMutation,
    scenarios: ATATestScenario[],
    results: ATADryRunResult[],
  ): Promise<ATAReviewVerdict>;

  /** Revise a skill based on ROA feedback (reuses mutation LLM with extra context). */
  reviseSkill(
    mutation: SkillMutation,
    feedback: string,
  ): Promise<{ content: string; trigger: string; description: string }>;
}

let deps: SkillTesterDeps | null = null;

export function setSkillTesterDeps(d: SkillTesterDeps): void {
  deps = d;
}

export function hasSkillTesterDeps(): boolean {
  return deps !== null;
}

// ── Constants ────────────────────────────────────────────

const MAX_REVISION_CYCLES = 2;

// ── Core entry point ─────────────────────────────────────

/**
 * Run the full ATA pipeline for a proposed mutation.
 *
 * This is the single entry point called after a mutation is created.
 * It orchestrates TGA → EAA → ROA with recursive revision.
 *
 * Returns the pipeline result with the final verdict.
 */
export async function runATAPipeline(mutationId: string): Promise<ATAPipelineResult> {
  if (!deps) {
    throw new Error("[SkillTester] ATA deps not configured");
  }

  const mutation = getMutationById(mutationId);
  if (!mutation) {
    throw new Error(`[SkillTester] Mutation ${mutationId} not found`);
  }

  if (mutation.status !== "proposed" && mutation.status !== "revision") {
    throw new Error(`[SkillTester] Mutation ${mutationId} has status "${mutation.status}", expected "proposed" or "revision"`);
  }

  // Mark as testing
  updateMutationStatus(mutationId, "testing");

  let currentMutation = mutation;
  let revisionCycles = 0;
  let lastResult: {
    scenarios: ATATestScenario[];
    results: ATADryRunResult[];
    verdict: ATAReviewVerdict;
  } | null = null;

  // Pipeline loop (initial + up to MAX_REVISION_CYCLES revisions)
  while (revisionCycles <= MAX_REVISION_CYCLES) {
    // Step 1: TGA — Generate test scenarios
    const scenarios = await deps.generateTestScenarios(currentMutation);
    console.log(`[ATA:TGA] Generated ${scenarios.length} test scenarios for ${mutationId}`);

    // Step 2: EAA — Dry-run each scenario (sequential to control cost)
    const dryRunResults: ATADryRunResult[] = [];
    for (const scenario of scenarios) {
      const result = await deps.executeDryRun(currentMutation.proposedSkill, scenario);
      dryRunResults.push(result);
    }
    console.log(`[ATA:EAA] Completed ${dryRunResults.length} dry-runs for ${mutationId}`);

    // Step 3: ROA — Review results
    const verdict = await deps.reviewResults(currentMutation, scenarios, dryRunResults);
    console.log(`[ATA:ROA] Verdict for ${mutationId}: ${verdict.verdict} (score=${verdict.overallScore})`);

    lastResult = { scenarios, results: dryRunResults, verdict };

    // Handle verdict
    if (verdict.verdict === "approve") {
      break;
    }

    if (verdict.verdict === "reject") {
      break;
    }

    // verdict === "revise"
    if (revisionCycles >= MAX_REVISION_CYCLES) {
      // Max revisions reached — auto-reject
      console.log(`[ATA] Max revision cycles (${MAX_REVISION_CYCLES}) reached for ${mutationId}, auto-rejecting`);
      lastResult.verdict = { ...verdict, verdict: "reject" };
      break;
    }

    // Revise the skill with ROA feedback
    const feedback = verdict.revisionGuidance ?? "Improve the skill to pass all test scenarios.";
    console.log(`[ATA] Revision cycle ${revisionCycles + 1} for ${mutationId}: ${feedback}`);

    const revised = await deps.reviseSkill(currentMutation, feedback);

    // Update the mutation's proposed skill with the revised content
    currentMutation = {
      ...currentMutation,
      proposedSkill: {
        ...currentMutation.proposedSkill,
        content: revised.content,
        trigger: revised.description || revised.trigger || currentMutation.proposedSkill.trigger,
      },
      revisionCycle: revisionCycles + 1,
    };

    // Persist the revision state
    updateMutationStatus(mutationId, "revision", {
      revisionCycle: revisionCycles + 1,
      reviewFeedback: feedback,
    });

    revisionCycles++;
  }

  if (!lastResult) {
    throw new Error(`[SkillTester] Pipeline produced no result for ${mutationId}`);
  }

  // Apply final verdict
  const finalVerdict = lastResult.verdict.verdict;

  if (finalVerdict === "approve") {
    // Deprecate old skill, activate new, status="merged"
    applyMergedMutation({
      ...currentMutation,
      proposedSkill: currentMutation.proposedSkill,
    });
    console.log(`[ATA] APPROVED: ${mutationId} → skill ${currentMutation.proposedSkill.name} v${currentMutation.proposedSkill.version} now active`);
  } else {
    // Reject
    updateMutationStatus(mutationId, "rejected", {
      reviewFeedback: lastResult.verdict.revisionGuidance ?? "Rejected by ATA pipeline",
    });
    console.log(`[ATA] REJECTED: ${mutationId} (score=${lastResult.verdict.overallScore})`);
  }

  return {
    mutationId,
    verdict: finalVerdict as "approve" | "reject",
    testScenarios: lastResult.scenarios,
    dryRunResults: lastResult.results,
    reviewVerdict: lastResult.verdict,
    revisionCycles,
    completedAt: new Date().toISOString(),
  };
}
