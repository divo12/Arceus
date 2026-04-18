/**
 * Spec 14 – Phase 2: Skill Mutator (Pure Logic Layer)
 *
 * Decision logic for failure attribution + skill mutation.
 * LLM calls are injected via SkillMutatorDeps — this module never
 * imports azure-openai, Zod response schemas, or structuredCompletion.
 *
 * Architecture:
 *   company-runtime/skill-mutator.ts  → decides WHAT to analyze and WHEN to mutate
 *   apps/api/skill-evolution.ts       → provides HOW (LLM calls, Zod schemas)
 *
 * Data flow on task terminal status:
 *   1. processTaskOutcome() called from setTaskStatus
 *   2. Updates skill success rates (replaces old Path B — NO duplicate)
 *   3. If failed or high friction: calls deps.analyzeFailure()
 *   4. If confidence > 0.6: calls deps.proposeSkillMutation() or .proposeSkillDiscovery()
 *   5. Stores SkillMutation with status "proposed"
 */

import type { FailureAttribution, SkillArtifact, SkillMutation } from "@arceus/contracts";
import {
  matchSkills,
  getSkillById,
  storeAttribution,
  storeMutation,
  updateSuccessRate,
} from "./skill-registry";

// ── Dependency injection ─────────────────────────────────

export interface SkillMutatorDeps {
  /** LLM-backed failure analysis. Returns raw attribution fields. */
  analyzeFailure(ctx: TaskOutcomeContext, matchedSkills: SkillArtifact[]): Promise<{
    attributedSkillId: string | null;
    failureMode: string;
    confidence: number;
    suggestedFix: string;
    isSkillGap: boolean;
  }>;

  /** LLM-backed skill rewrite. Returns new content + trigger + description. */
  proposeSkillMutation(original: SkillArtifact, attribution: FailureAttribution): Promise<{
    content: string;
    trigger: string;
    description: string;
  }>;

  /** LLM-backed new skill creation. Returns content + trigger + name + description. */
  proposeSkillDiscovery(attribution: FailureAttribution, role: string): Promise<{
    content: string;
    trigger: string;
    name: string;
    description: string;
  }>;
}

let deps: SkillMutatorDeps | null = null;

export function setSkillMutatorDeps(d: SkillMutatorDeps): void {
  deps = d;
}

export function hasSkillMutatorDeps(): boolean {
  return deps !== null;
}

// ── Constants ────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.6;

// ── Task Outcome Context ─────────────────────────────────

export interface TaskOutcomeContext {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  assignedRole: string;
  companyId: string;
  status: "completed" | "failed";
  iterationCount: number;
  executionTrace?: string;
}

// ── Core entry point ─────────────────────────────────────

/**
 * Single entry point called from setTaskStatus on completed/failed.
 *
 * Replaces the old "Path B" (matchSkills + updateSuccessRate in setTaskStatus).
 * Does NOT call recordSkillUsage — that already happened at prompt-build time (Path A).
 *
 * Returns the proposed mutation if one was created, null otherwise.
 */
export async function processTaskOutcome(ctx: TaskOutcomeContext): Promise<SkillMutation | null> {
  // Step 1: Match skills + update success rates (replaces old Path B)
  const matchedSkills = matchSkills(ctx.companyId, ctx.assignedRole, `${ctx.taskTitle} ${ctx.taskDescription}`);

  const skillOutcome = ctx.status === "completed"
    ? (ctx.iterationCount <= 1 ? 1.0 : Math.max(0.4, 1.0 - ctx.iterationCount * 0.15))
    : 0.0; // failed

  for (const skill of matchedSkills) {
    updateSuccessRate(skill.id, skillOutcome);
  }

  // Step 2: Determine if attribution is needed
  const shouldAnalyze = ctx.status === "failed" || ctx.iterationCount >= 3;
  if (!shouldAnalyze) return null;

  // Step 3: Require deps for LLM-backed analysis
  if (!deps) {
    console.warn("[SkillMutator] LLM deps not configured, skipping failure attribution");
    return null;
  }

  // Step 4: Failure attribution via LLM
  const raw = await deps.analyzeFailure(ctx, matchedSkills);

  const attribution: FailureAttribution = {
    taskId: ctx.taskId,
    outcome: ctx.status === "failed" ? "failed" : "high_friction",
    attributedSkillId: raw.attributedSkillId,
    failureMode: raw.failureMode,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    suggestedFix: raw.suggestedFix,
    isSkillGap: raw.isSkillGap,
    createdAt: new Date().toISOString(),
  };
  storeAttribution(attribution);

  // Step 5: Only propose mutation if confidence exceeds threshold
  if (attribution.confidence <= CONFIDENCE_THRESHOLD) {
    console.log(`[SkillMutator] Attribution confidence ${attribution.confidence} <= ${CONFIDENCE_THRESHOLD}, logged but no mutation`);
    return null;
  }

  // Step 6: Skill gap → discovery; existing skill → mutation
  if (attribution.isSkillGap) {
    return createDiscoveryMutation(attribution, ctx.companyId, ctx.assignedRole);
  }
  return createSkillMutation(attribution, ctx.companyId);
}

// ── Internal: create mutation proposals ──────────────────

async function createSkillMutation(
  attribution: FailureAttribution,
  companyId: string,
): Promise<SkillMutation> {
  const original = attribution.attributedSkillId
    ? getSkillById(attribution.attributedSkillId)
    : null;

  if (!original) {
    throw new Error(`[SkillMutator] Skill ${attribution.attributedSkillId} not found for mutation`);
  }

  const result = await deps!.proposeSkillMutation(original, attribution);
  const newVersion = original.version + 1;

  const proposedSkill: SkillArtifact = {
    id: `skill-${original.name}-v${newVersion}`,
    companyId,
    name: original.name,
    role: original.role,
    version: newVersion,
    status: "draft",
    trigger: result.description || result.trigger || original.trigger,
    content: result.content,
    testCases: [],
    successRate: original.successRate,
    usageCount: 0,
    lastUsedAt: null,
    mutatedFromId: original.id,
    mutatedBy: "skill_mutator",
    mutationReason: `${attribution.failureMode}: ${attribution.suggestedFix}`,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  };

  const mutation: SkillMutation = {
    id: `mutation-${original.name}-v${newVersion}-${Date.now()}`,
    companyId,
    originalSkillId: original.id,
    proposedSkill,
    reason: `${attribution.failureMode}: ${attribution.suggestedFix}`,
    failureTraceId: attribution.taskId,
    status: "proposed",
    revisionCycle: 0,
    testResults: [],
    reviewFeedback: null,
    proposedBy: "skill_mutator",
    proposedAt: new Date().toISOString(),
    resolvedAt: null,
  };

  storeMutation(mutation);
  return mutation;
}

async function createDiscoveryMutation(
  attribution: FailureAttribution,
  companyId: string,
  role: string,
): Promise<SkillMutation> {
  const result = await deps!.proposeSkillDiscovery(attribution, role);
  const skillName = result.name || `discovered-${Date.now()}`;

  const proposedSkill: SkillArtifact = {
    id: `skill-${skillName}-v1`,
    companyId,
    name: skillName,
    role,
    version: 1,
    status: "draft",
    trigger: result.description || result.trigger,
    content: result.content,
    testCases: [],
    successRate: 0.5,
    usageCount: 0,
    lastUsedAt: null,
    mutatedFromId: null,
    mutatedBy: "skill_mutator",
    mutationReason: `Skill gap: ${attribution.failureMode}`,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  };

  const mutation: SkillMutation = {
    id: `mutation-discovery-${skillName}-${Date.now()}`,
    companyId,
    originalSkillId: null,
    proposedSkill,
    reason: `Skill gap: ${attribution.failureMode}`,
    failureTraceId: attribution.taskId,
    status: "proposed",
    revisionCycle: 0,
    testResults: [],
    reviewFeedback: null,
    proposedBy: "skill_mutator",
    proposedAt: new Date().toISOString(),
    resolvedAt: null,
  };

  storeMutation(mutation);
  return mutation;
}
