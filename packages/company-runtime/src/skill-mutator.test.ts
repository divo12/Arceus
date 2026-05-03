import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerSkill,
  resetRegistry,
  seedExistingSkills,
  getSkillById,
  getMutationsForCompany,
  getMutationById,
  getPendingMutations,
  getAttributionsForCompany,
  updateMutationStatus,
  applyMergedMutation,
  getSkillsForRole,
  storeMutation,
  storeAttribution,
} from "./skill-registry";
import {
  processTaskOutcome,
  setSkillMutatorDeps,
} from "./skill-mutator";
import type { SkillArtifact, SkillMutation, FailureAttribution } from "@arceus/contracts";

// ── Test helpers ─────────────────────────────────────────

function makeSkill(overrides: Partial<SkillArtifact> = {}): SkillArtifact {
  return {
    id: "skill-test-v1",
    companyId: "company_test",
    name: "test-skill",
    role: "developer",
    version: 1,
    status: "active",
    trigger: "When writing tests or test infrastructure",
    content: "# Test Skill\n\n1. Write tests first\n2. Run them\n3. Fix failures",
    testCases: [],
    resources: [],
    successRate: 0.7,
    usageCount: 5,
    lastUsedAt: null,
    mutatedFromId: null,
    mutatedBy: null,
    mutationReason: null,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Fake LLM deps — returns canned responses, no network calls */
function installFakeDeps(options?: {
  confidence?: number;
  isSkillGap?: boolean;
  attributedSkillId?: string | null;
}) {
  setSkillMutatorDeps({
    async analyzeFailure(_ctx, _skills) {
      return {
        attributedSkillId: options?.attributedSkillId ?? "skill-test-v1",
        failureMode: "missing_error_handling",
        confidence: options?.confidence ?? 0.85,
        suggestedFix: "Add try-catch around async operations",
        isSkillGap: options?.isSkillGap ?? false,
      };
    },
    async proposeSkillMutation(_original, _attribution) {
      return {
        content: "# Test Skill v2\n\n1. Write tests first\n2. Add error handling\n3. Run them",
        trigger: "When writing tests or test infrastructure",
        description: "Test skill mutation proposal",
      };
    },
    async proposeSkillDiscovery(_attribution, _role) {
      return {
        content: "# Error Handling Skill\n\n1. Always use try-catch\n2. Log errors",
        trigger: "When handling errors in async code",
        name: "error-handling",
        description: "Handle errors in async code",
      };
    },
  });
}

// ── Tests ────────────────────────────────────────────────

describe("Mutation + Attribution storage", () => {
  beforeEach(() => resetRegistry());

  it("stores and retrieves mutations", () => {
    const mutation: SkillMutation = {
      id: "mutation-1",
      companyId: "company_test",
      originalSkillId: "skill-test-v1",
      proposedSkill: makeSkill({ id: "skill-test-v2", version: 2, status: "draft" }),
      reason: "test reason",
      failureTraceId: "task_1",
      status: "proposed",
      revisionCycle: 0,
      testResults: [],
      reviewFeedback: null,
      proposedBy: "skill_mutator",
      proposedAt: new Date().toISOString(),
      resolvedAt: null,
    };
    storeMutation(mutation);

    const retrieved = getMutationById("mutation-1");
    assert.ok(retrieved);
    assert.equal(retrieved.status, "proposed");
    assert.equal(retrieved.reason, "test reason");
  });

  it("updates mutation status and sets resolvedAt on terminal states", () => {
    const mutation: SkillMutation = {
      id: "mutation-2",
      companyId: "company_test",
      originalSkillId: null,
      proposedSkill: makeSkill({ id: "skill-new-v1", version: 1 }),
      reason: "gap",
      failureTraceId: null,
      status: "proposed",
      revisionCycle: 0,
      testResults: [],
      reviewFeedback: null,
      proposedBy: "skill_mutator",
      proposedAt: new Date().toISOString(),
      resolvedAt: null,
    };
    storeMutation(mutation);

    const updated = updateMutationStatus("mutation-2", "rejected");
    assert.ok(updated);
    assert.equal(updated.status, "rejected");
    assert.ok(updated.resolvedAt, "resolvedAt should be set on rejection");
  });

  it("getPendingMutations returns only proposed/revision", () => {
    storeMutation({
      id: "m-proposed",
      companyId: "c1",
      originalSkillId: null,
      proposedSkill: makeSkill(),
      reason: "a",
      failureTraceId: null,
      status: "proposed",
      revisionCycle: 0,
      testResults: [],
      reviewFeedback: null,
      proposedBy: "test",
      proposedAt: new Date().toISOString(),
      resolvedAt: null,
    });
    storeMutation({
      id: "m-rejected",
      companyId: "c1",
      originalSkillId: null,
      proposedSkill: makeSkill(),
      reason: "b",
      failureTraceId: null,
      status: "rejected",
      revisionCycle: 0,
      testResults: [],
      reviewFeedback: null,
      proposedBy: "test",
      proposedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
    });

    const pending = getPendingMutations("c1");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "m-proposed");
  });

  it("stores and retrieves attributions", () => {
    const skill = makeSkill();
    registerSkill(skill);

    const attr: FailureAttribution = {
      taskId: "task_1",
      outcome: "failed",
      attributedSkillId: skill.id,
      failureMode: "wrong_library",
      confidence: 0.9,
      suggestedFix: "Use jose instead of jsonwebtoken",
      isSkillGap: false,
      createdAt: new Date().toISOString(),
    };
    storeAttribution(attr);

    const attrs = getAttributionsForCompany("company_test");
    assert.equal(attrs.length, 1);
    assert.equal(attrs[0].failureMode, "wrong_library");
  });

  it("applyMergedMutation deprecates old and activates new", () => {
    const old = makeSkill();
    registerSkill(old);

    const mutation: SkillMutation = {
      id: "m-merge",
      companyId: "company_test",
      originalSkillId: old.id,
      proposedSkill: makeSkill({ id: "skill-test-v2", version: 2, status: "draft", content: "v2 content" }),
      reason: "fix",
      failureTraceId: null,
      status: "approved",
      revisionCycle: 0,
      testResults: [],
      reviewFeedback: null,
      proposedBy: "test",
      proposedAt: new Date().toISOString(),
      resolvedAt: null,
    };
    storeMutation(mutation);

    const newSkill = applyMergedMutation(mutation);
    assert.equal(newSkill.status, "active");
    assert.equal(newSkill.version, 2);
    assert.ok(newSkill.approvedAt);

    const oldAfter = getSkillById(old.id);
    assert.ok(oldAfter);
    assert.equal(oldAfter.status, "deprecated");

    const mutAfter = getMutationById("m-merge");
    assert.equal(mutAfter?.status, "merged");
  });
});

describe("processTaskOutcome", () => {
  beforeEach(() => {
    resetRegistry();
    installFakeDeps();
  });

  it("updates success rate on clean completion (no attribution)", async () => {
    const skill = makeSkill({ successRate: 0.7 });
    registerSkill(skill);

    const result = await processTaskOutcome({
      taskId: "task_clean",
      taskTitle: "Write tests for test infrastructure",
      taskDescription: "Build test infrastructure",
      assignedRole: "developer",
      companyId: "company_test",
      status: "completed",
      iterationCount: 1,
    });

    // Clean success → no mutation
    assert.equal(result, null);

    // Success rate should have increased via EMA: 0.7 * 0.85 + 1.0 * 0.15 = 0.745
    const updated = getSkillById(skill.id);
    assert.ok(updated);
    assert.ok(Math.abs(updated.successRate - 0.745) < 0.01, `Expected ~0.745, got ${updated.successRate}`);

    // No attributions should exist
    const attrs = getAttributionsForCompany("company_test");
    assert.equal(attrs.length, 0);
  });

  it("triggers attribution + mutation on task failure", async () => {
    const skill = makeSkill();
    registerSkill(skill);

    const result = await processTaskOutcome({
      taskId: "task_fail",
      taskTitle: "Write tests for test infrastructure",
      taskDescription: "Build test infrastructure",
      assignedRole: "developer",
      companyId: "company_test",
      status: "failed",
      iterationCount: 1,
    });

    // Should have a proposed mutation
    assert.ok(result);
    assert.equal(result.status, "proposed");
    assert.equal(result.originalSkillId, "skill-test-v1");
    assert.ok(result.proposedSkill.content.includes("v2"));
    assert.equal(result.proposedSkill.version, 2);

    // Attribution should be stored
    const attrs = getAttributionsForCompany("company_test");
    assert.equal(attrs.length, 1);
    assert.equal(attrs[0].outcome, "failed");
    assert.equal(attrs[0].failureMode, "missing_error_handling");

    // Mutation should be in storage
    const mutations = getMutationsForCompany("company_test");
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].status, "proposed");
  });

  it("triggers attribution on high friction (iterationCount >= 3)", async () => {
    const skill = makeSkill();
    registerSkill(skill);

    const result = await processTaskOutcome({
      taskId: "task_friction",
      taskTitle: "Write tests for test infrastructure",
      taskDescription: "Build test infrastructure",
      assignedRole: "developer",
      companyId: "company_test",
      status: "completed",
      iterationCount: 4,
    });

    // High friction → still triggers mutation
    assert.ok(result);
    assert.equal(result.status, "proposed");

    const attrs = getAttributionsForCompany("company_test");
    assert.equal(attrs.length, 1);
    assert.equal(attrs[0].outcome, "high_friction");
  });

  it("logs attribution but no mutation when confidence <= 0.6", async () => {
    installFakeDeps({ confidence: 0.4 });
    const skill = makeSkill();
    registerSkill(skill);

    const result = await processTaskOutcome({
      taskId: "task_lowconf",
      taskTitle: "Write tests for test infrastructure",
      taskDescription: "Build test infrastructure",
      assignedRole: "developer",
      companyId: "company_test",
      status: "failed",
      iterationCount: 1,
    });

    // Low confidence → no mutation
    assert.equal(result, null);

    // Attribution still stored
    const attrs = getAttributionsForCompany("company_test");
    assert.equal(attrs.length, 1);
    assert.equal(attrs[0].confidence, 0.4);

    // No mutations
    assert.equal(getMutationsForCompany("company_test").length, 0);
  });

  it("triggers skill discovery when isSkillGap is true", async () => {
    installFakeDeps({ isSkillGap: true, attributedSkillId: null });
    const skill = makeSkill();
    registerSkill(skill);

    const result = await processTaskOutcome({
      taskId: "task_gap",
      taskTitle: "Handle API rate limiting",
      taskDescription: "Implement rate limit handling",
      assignedRole: "developer",
      companyId: "company_test",
      status: "failed",
      iterationCount: 1,
    });

    assert.ok(result);
    assert.equal(result.originalSkillId, null, "Discovery has no original skill");
    assert.equal(result.proposedSkill.name, "error-handling");
    assert.equal(result.proposedSkill.version, 1);
    assert.ok(result.reason.includes("Skill gap"));
  });

  it("does NOT call recordSkillUsage (no double-count with Path A)", async () => {
    const skill = makeSkill({ usageCount: 5 });
    registerSkill(skill);

    await processTaskOutcome({
      taskId: "task_nodup",
      taskTitle: "Write tests for test infrastructure",
      taskDescription: "Build test infrastructure",
      assignedRole: "developer",
      companyId: "company_test",
      status: "completed",
      iterationCount: 1,
    });

    // usageCount should NOT have changed — Path A records usage, not processTaskOutcome
    const updated = getSkillById(skill.id);
    assert.ok(updated);
    assert.equal(updated.usageCount, 5, "usageCount must not increment in processTaskOutcome");
  });
});
