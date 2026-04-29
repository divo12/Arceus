import {
  analyzeSprintPatterns,
  checkSkillCandidates,
  proposeSkillFromCluster,
  runATAPipeline,
} from "@arceus/company-runtime";
import { applyGovernanceToMutation } from "./governance.js";
import { swallowAndAudit } from "../observability/swallow.js";

/**
 * Spec 14 Phase 6: Cross-sprint pattern transfer.
 *
 * Runs at sprint boundary. Filters patterns to those first observed in the
 * just-completed sprint that recurred ≥3 times AND are shared across multiple
 * sprints, clusters them, applies promotion gate, governs each candidate, and
 * hands approved mutations to the ATA pipeline.
 *
 * Unlike the older all-time sweep (runPatternPromotionSweep), this sprint-
 * scoped version ensures only the *current* sprint's patterns propagate to the
 * next one — satisfying spec §1095 ("propagate to next sprint").
 *
 * Fire-and-forget from the caller; returns observability counts.
 */
export async function runCrossSprintTransfer(
  companyId: string,
  sprintId: string,
): Promise<{
  candidatesFound: number;
  mutationsProposed: number;
  mutationsRefused: number;
}> {
  const candidates = analyzeSprintPatterns(companyId, sprintId, 3);
  let mutationsProposed = 0;
  let mutationsRefused = 0;

  for (const candidate of candidates) {
    try {
      const mutation = await proposeSkillFromCluster(candidate);

      // Phase 6: governance gate before ATA (pattern_learner bypasses trust/own-role).
      const gov = await applyGovernanceToMutation({
        mutation,
        companyId,
        sprintId,
        proposerAgentId: null,
        proposerRole: "pattern_learner",
        estimatedCostCents: 2, // synthesizeSkill via gpt-4o ≈ $0.015
      });
      if (!gov.allowed) {
        mutationsRefused++;
        console.warn(`[Governance] Emergent mutation ${mutation.id} refused — ${gov.code}: ${gov.reason}`);
        continue;
      }

      mutationsProposed++;
      console.log(
        `[CrossSprintTransfer] Promoted cluster ${candidate.clusterId} → mutation ${mutation.id} ` +
        `(${candidate.memberCount} members, success=${candidate.combinedSuccessRate.toFixed(2)})`,
      );
      // Audit C3.2 (F-279): emergent ATA pipeline is fire-and-forget but
      // failures must land in the audit trail — without this a refused
      // mutation looks identical to a crashed pipeline at the operator level.
      swallowAndAudit("ata.pipeline_emergent", async () => {
        const result = await runATAPipeline(mutation.id);
        console.log(`[ATA] Emergent ${result.verdict.toUpperCase()} for ${mutation.id} (score=${result.reviewVerdict.overallScore})`);
      },
        { companyId, detail: { mutationId: mutation.id, clusterId: candidate.clusterId } },
      );
    } catch (err) {
      console.warn(`[CrossSprintTransfer] proposeSkillFromCluster failed for ${candidate.clusterId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { candidatesFound: candidates.length, mutationsProposed, mutationsRefused };
}

/**
 * @deprecated Use runCrossSprintTransfer(companyId, sprintId) instead.
 * Retained only for tests that exercise the all-time sweep path.
 */
export async function runPatternPromotionSweep(companyId: string): Promise<{
  candidatesFound: number;
  mutationsProposed: number;
}> {
  const candidates = checkSkillCandidates(companyId);
  let mutationsProposed = 0;
  for (const candidate of candidates) {
    try {
      const mutation = await proposeSkillFromCluster(candidate);
      mutationsProposed++;
      swallowAndAudit("ata.pipeline.emergent", () => runATAPipeline(mutation.id), {
        companyId,
        agentRole: "skills_lead",
        detail: { mutationId: mutation.id, clusterId: candidate.clusterId },
      });
    } catch (err) {
      console.warn(`[PatternLearner] proposeSkillFromCluster failed for ${candidate.clusterId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { candidatesFound: candidates.length, mutationsProposed };
}
