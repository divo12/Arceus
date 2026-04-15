import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractPattern,
  clusterPatterns,
  checkSkillCandidates,
  proposeSkillFromCluster,
  cosineSimilarity,
  applyEma,
  setPatternLearnerDeps,
  resetPatternStore,
  getPatternsForCompany,
  getPatternCount,
} from "./pattern-learner";
import {
  registerSkill,
  resetRegistry,
  getMutationById,
} from "./skill-registry";
import type { PatternLearnerDeps, PatternObservation } from "./pattern-learner";
import type { SkillArtifact, SkillCandidate } from "@arceus/contracts";

// ── Test helpers ────────────────────────────────────────

function makeObservation(overrides?: Partial<PatternObservation>): PatternObservation {
  return {
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    taskTitle: "Add a login button",
    taskDescription: "Add a Supabase Auth login button to the landing page",
    assignedRole: "developer",
    companyId: "company-a",
    outcome: "success",
    trajectory: "Created LoginButton.tsx, wired useAuth hook, tested click.",
    activeSkillIds: [],
    tags: [],
    ...overrides,
  };
}

function makeSkill(overrides?: Partial<SkillArtifact>): SkillArtifact {
  return {
    id: "skill-auth-v1",
    companyId: "company-a",
    name: "auth-setup",
    role: "developer",
    version: 1,
    status: "active",
    trigger: "When adding auth",
    content: "# Auth Setup\n\nUse Supabase.",
    testCases: [],
    successRate: 0.8,
    usageCount: 10,
    lastUsedAt: null,
    mutatedFromId: null,
    mutatedBy: null,
    mutationReason: null,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

function normalize(v: readonly number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Sequence-based fake embedder: returns vectors from a queue in order.
 * Each call consumes one vector. Useful for fully deterministic cluster tests.
 */
function makeSequenceEmbedder(vectors: number[][]): PatternLearnerDeps["embedText"] {
  let i = 0;
  return async () => {
    if (i >= vectors.length) throw new Error(`Embedder sequence exhausted (i=${i})`);
    const v = vectors[i++];
    return normalize(v);
  };
}

/** Default fake synthesizer — never touches embedText (caller must provide). */
function makeFakeSynthesizer(): PatternLearnerDeps["synthesizeSkill"] {
  return async (candidate: SkillCandidate) => ({
    name: `emergent-${candidate.role}`,
    trigger: `Synthesized trigger for ${candidate.representativeTitle}`,
    content: `# Emergent Skill\n\nLearned from ${candidate.memberCount} patterns.`,
    description: "Emergent description",
  });
}

/** Deps where every embedText call returns the same (normalized) vector. */
function fixedVectorDeps(vector: number[]): PatternLearnerDeps {
  const norm = normalize(vector);
  return {
    embedText: async () => norm,
    synthesizeSkill: makeFakeSynthesizer(),
  };
}

/** Deps using a sequence of pre-computed vectors. */
function sequenceDeps(vectors: number[][]): PatternLearnerDeps {
  return {
    embedText: makeSequenceEmbedder(vectors),
    synthesizeSkill: makeFakeSynthesizer(),
  };
}

// ── Pure helper tests ───────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  });

  it("returns 0 for orthogonal vectors", () => {
    assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  });

  it("returns 0 for zero-length mismatched vectors", () => {
    assert.equal(cosineSimilarity([], [1, 2, 3]), 0);
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  it("returns 0 when either vector is a zero vector", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  });

  it("computes known similarity correctly", () => {
    // Vectors at 45°: cos = 1/√2 ≈ 0.7071
    const sim = cosineSimilarity([1, 1], [1, 0]);
    assert.ok(Math.abs(sim - Math.cos(Math.PI / 4)) < 0.0001);
  });
});

describe("applyEma", () => {
  it("moves toward success outcome", () => {
    const next = applyEma(0.5, 1.0, 0.5);
    assert.equal(next, 0.75);
  });

  it("moves toward failure outcome", () => {
    const next = applyEma(0.5, 0, 0.5);
    assert.equal(next, 0.25);
  });

  it("clamps outcome to [0, 1]", () => {
    const next = applyEma(0.5, 10, 0.5);
    assert.equal(next, 0.75);
  });

  it("clamps result to [0, 1]", () => {
    const next = applyEma(1, 1, 0.5);
    assert.equal(next, 1);
  });

  it("uses default learning rate when not provided", () => {
    const next = applyEma(0.5, 1.0);
    // 0.5 * 0.85 + 1.0 * 0.15 = 0.575
    assert.ok(Math.abs(next - 0.575) < 0.0001);
  });
});

// ── extractPattern tests ────────────────────────────────

describe("extractPattern", () => {
  beforeEach(() => {
    resetPatternStore();
    resetRegistry();
  });

  it("creates a new pattern for a fresh trajectory", async () => {
    setPatternLearnerDeps(sequenceDeps([[1, 0, 0, 0]]));
    const obs = makeObservation({ taskId: "task-1" });
    const pattern = await extractPattern(obs);

    assert.equal(pattern.companyId, "company-a");
    assert.equal(pattern.role, "developer");
    assert.equal(pattern.usageCount, 1);
    assert.equal(pattern.successRate, 1.0); // success outcome
    assert.deepEqual(pattern.sourceTaskIds, ["task-1"]);
    assert.ok(pattern.embedding.length > 0);
    assert.equal(getPatternCount(), 1);
  });

  it("outcome score: high_friction → 0.5, failure → 0", async () => {
    // Orthogonal vectors → cannot merge, so two distinct patterns
    setPatternLearnerDeps(sequenceDeps([[1, 0, 0, 0], [0, 1, 0, 0]]));
    const f = await extractPattern(makeObservation({ taskId: "t-f", outcome: "failure", taskTitle: "X" }));
    const h = await extractPattern(makeObservation({ taskId: "t-h", outcome: "high_friction", taskTitle: "Y" }));
    assert.equal(f.successRate, 0);
    assert.equal(h.successRate, 0.5);
  });

  it("merges near-duplicate pattern (same embedding) and increments usageCount", async () => {
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    setPatternLearnerDeps(fixedVectorDeps(vec));

    const first = await extractPattern(makeObservation({ taskId: "task-a" }));
    const second = await extractPattern(makeObservation({ taskId: "task-b" }));

    assert.equal(getPatternCount(), 1, "Should merge into one pattern");
    assert.equal(second.id, first.id);
    assert.equal(second.usageCount, 2);
    assert.deepEqual(second.sourceTaskIds, ["task-a", "task-b"]);
  });

  it("EMA updates successRate on merge", async () => {
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    setPatternLearnerDeps(fixedVectorDeps(vec));

    const first = await extractPattern(makeObservation({ taskId: "task-a", outcome: "success" }));
    assert.equal(first.successRate, 1.0);

    const second = await extractPattern(makeObservation({ taskId: "task-b", outcome: "failure" }));
    // EMA with default lr=0.15: 1.0 * 0.85 + 0 * 0.15 = 0.85
    assert.ok(Math.abs(second.successRate - 0.85) < 0.0001);
  });

  it("does NOT merge if different role", async () => {
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    setPatternLearnerDeps(fixedVectorDeps(vec));

    await extractPattern(makeObservation({ taskId: "task-a", assignedRole: "developer" }));
    await extractPattern(makeObservation({ taskId: "task-b", assignedRole: "designer" }));

    assert.equal(getPatternCount(), 2, "Different roles should NOT merge");
  });

  it("succeeds once deps are configured", async () => {
    setPatternLearnerDeps(sequenceDeps([[1, 0, 0, 0]]));
    const pattern = await extractPattern(makeObservation());
    assert.ok(pattern);
  });
});

// ── clusterPatterns tests ───────────────────────────────

describe("clusterPatterns", () => {
  beforeEach(() => {
    resetPatternStore();
    resetRegistry();
  });

  it("returns empty array when no patterns", () => {
    const clusters = clusterPatterns("company-a");
    assert.deepEqual(clusters, []);
  });

  it("groups patterns with similar embeddings into one cluster", async () => {
    // Three vectors sharing a dominant axis + distinct secondary axis.
    // Normalized: each cos(pair) ≈ 0.80 — above cluster threshold (0.7),
    // below pattern-merge threshold (0.9).
    setPatternLearnerDeps(sequenceDeps([
      [1, 0.5, 0, 0],
      [1, 0, 0.5, 0],
      [1, 0, 0, 0.5],
    ]));
    await extractPattern(makeObservation({ taskId: "t1", taskTitle: "Task A" }));
    await extractPattern(makeObservation({ taskId: "t2", taskTitle: "Task B" }));
    await extractPattern(makeObservation({ taskId: "t3", taskTitle: "Task C" }));

    // Confirm no merge happened
    assert.equal(getPatternCount(), 3, "Each observation should produce a distinct Pattern");

    const clusters = clusterPatterns("company-a");
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].patternIds.length, 3);
  });

  it("keeps dissimilar patterns in separate groups (singletons filtered out)", async () => {
    // Orthogonal vectors → cos = 0 < 0.7 cluster threshold
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]));
    await extractPattern(makeObservation({ taskId: "t1", taskTitle: "Login flow" }));
    await extractPattern(makeObservation({ taskId: "t2", taskTitle: "Database schema" }));

    // Both singletons — filtered out (we only keep clusters with >=2 members)
    const clusters = clusterPatterns("company-a");
    assert.equal(clusters.length, 0);
  });

  it("scopes clusters to role — does not merge across roles", async () => {
    // Two similar-but-distinct vectors per role (cos ≈ 0.78 — clusters but doesn't merge)
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],      // dev1
      [1, 0.8, 0, 0],    // dev2
      [1, 0, 0, 0],      // des1 (same direction as dev1 but different role)
      [1, 0.8, 0, 0],    // des2
    ]));
    await extractPattern(makeObservation({ taskId: "dev1", assignedRole: "developer", taskTitle: "A" }));
    await extractPattern(makeObservation({ taskId: "dev2", assignedRole: "developer", taskTitle: "B" }));
    await extractPattern(makeObservation({ taskId: "des1", assignedRole: "designer", taskTitle: "C" }));
    await extractPattern(makeObservation({ taskId: "des2", assignedRole: "designer", taskTitle: "D" }));

    assert.equal(getPatternCount(), 4, "Patterns must not merge across roles");
    const clusters = clusterPatterns("company-a");
    assert.equal(clusters.length, 2);
    assert.ok(clusters.find((c) => c.role === "developer"));
    assert.ok(clusters.find((c) => c.role === "designer"));
  });

  it("computes combinedSuccessRate weighted by usageCount", async () => {
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [1, 0.8, 0, 0],
    ]));
    await extractPattern(makeObservation({ taskId: "t1", taskTitle: "A", outcome: "success" }));
    await extractPattern(makeObservation({ taskId: "t2", taskTitle: "B", outcome: "success" }));

    const clusters = clusterPatterns("company-a");
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0].combinedSuccessRate > 0.9);
    assert.equal(clusters[0].combinedUsageCount, 2);
  });
});

// ── checkSkillCandidates tests ──────────────────────────

describe("checkSkillCandidates", () => {
  beforeEach(() => {
    resetPatternStore();
    resetRegistry();
  });

  it("returns empty when no patterns", () => {
    const candidates = checkSkillCandidates("company-a");
    assert.deepEqual(candidates, []);
  });

  it("requires at least 4 members for candidate promotion", async () => {
    // 4 distinct but clusterable vectors
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [1, 0.8, 0, 0],
      [1, 0, 0.8, 0],
      [1, 0, 0, 0.8],
    ]));

    await extractPattern(makeObservation({ taskId: "t1", taskTitle: "Task 1" }));
    await extractPattern(makeObservation({ taskId: "t2", taskTitle: "Task 2" }));
    await extractPattern(makeObservation({ taskId: "t3", taskTitle: "Task 3" }));

    let candidates = checkSkillCandidates("company-a");
    assert.equal(candidates.length, 0, "Below threshold: no candidates");

    // 4th pattern → candidate emerges
    await extractPattern(makeObservation({ taskId: "t4", taskTitle: "Task 4" }));
    candidates = checkSkillCandidates("company-a");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].memberCount, 4);
    assert.ok(candidates[0].combinedSuccessRate >= 0.6);
  });

  it("rejects cluster with low success rate", async () => {
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [1, 0.8, 0, 0],
      [1, 0, 0.8, 0],
      [1, 0, 0, 0.8],
    ]));

    // 4 failures: combined success rate will be 0, below threshold
    await extractPattern(makeObservation({ taskId: "t1", taskTitle: "T1", outcome: "failure" }));
    await extractPattern(makeObservation({ taskId: "t2", taskTitle: "T2", outcome: "failure" }));
    await extractPattern(makeObservation({ taskId: "t3", taskTitle: "T3", outcome: "failure" }));
    await extractPattern(makeObservation({ taskId: "t4", taskTitle: "T4", outcome: "failure" }));

    const candidates = checkSkillCandidates("company-a");
    assert.equal(candidates.length, 0, "Low success rate → no candidate");
  });

  it("skips clusters when a matching active skill already exists", async () => {
    // Register an active skill that matches the pattern trigger keywords
    registerSkill(makeSkill({
      id: "skill-login-v1",
      name: "login-flow",
      role: "developer",
      trigger: "Add a login button",
      content: "# Login\n\nAdd a login button with Supabase",
    }));

    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [1, 0.8, 0, 0],
      [1, 0, 0.8, 0],
      [1, 0, 0, 0.8],
    ]));

    // 4 successful patterns whose titles match the skill trigger
    for (let i = 1; i <= 4; i++) {
      await extractPattern(makeObservation({
        taskId: `t${i}`,
        taskTitle: `Add a login button variant ${i}`,
      }));
    }

    const clusters = clusterPatterns("company-a");
    const candidates = checkSkillCandidates("company-a");

    // Any candidate returned must NOT be covered by an existing skill
    for (const cand of candidates) {
      const cluster = clusters.find((c) => c.id === cand.clusterId);
      assert.equal(cluster?.hasMatchingSkill, false, "candidates must not have matching skill");
    }
  });
});

// ── proposeSkillFromCluster tests ───────────────────────

describe("proposeSkillFromCluster", () => {
  beforeEach(() => {
    resetPatternStore();
    resetRegistry();
  });

  it("creates a SkillMutation with mutatedBy='pattern_learner' and originalSkillId=null", async () => {
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [1, 0.8, 0, 0],
      [1, 0, 0.8, 0],
      [1, 0, 0, 0.8],
    ]));

    for (let i = 1; i <= 4; i++) {
      await extractPattern(makeObservation({
        taskId: `t${i}`,
        taskTitle: `Novel task variant ${i}`,
      }));
    }

    const candidates = checkSkillCandidates("company-a");
    assert.equal(candidates.length, 1);

    const mutation = await proposeSkillFromCluster(candidates[0]);

    assert.equal(mutation.proposedBy, "pattern_learner");
    assert.equal(mutation.originalSkillId, null);
    assert.equal(mutation.status, "proposed");
    assert.equal(mutation.proposedSkill.mutatedBy, "pattern_learner");
    assert.equal(mutation.proposedSkill.status, "draft");
    assert.equal(mutation.proposedSkill.version, 1);

    // Mutation is stored in registry
    const stored = getMutationById(mutation.id);
    assert.ok(stored);
    assert.equal(stored!.id, mutation.id);
  });

  it("synthesized skill carries combinedSuccessRate as initial successRate", async () => {
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [1, 0.8, 0, 0],
      [1, 0, 0.8, 0],
      [1, 0, 0, 0.8],
    ]));

    for (let i = 1; i <= 4; i++) {
      await extractPattern(makeObservation({
        taskId: `t${i}`,
        taskTitle: `Novel task variant ${i}`,
        outcome: "success",
      }));
    }

    const candidates = checkSkillCandidates("company-a");
    assert.equal(candidates.length, 1);
    const mutation = await proposeSkillFromCluster(candidates[0]);

    assert.ok(mutation.proposedSkill.successRate >= 0.6);
  });
});

// ── Query + admin tests ─────────────────────────────────

describe("pattern store admin", () => {
  beforeEach(() => {
    resetPatternStore();
  });

  it("getPatternsForCompany scopes results by companyId", async () => {
    setPatternLearnerDeps(sequenceDeps([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ]));
    await extractPattern(makeObservation({ taskId: "t1", companyId: "a", taskTitle: "A" }));
    await extractPattern(makeObservation({ taskId: "t2", companyId: "a", taskTitle: "B" }));
    await extractPattern(makeObservation({ taskId: "t3", companyId: "b", taskTitle: "C" }));

    assert.equal(getPatternsForCompany("a").length, 2);
    assert.equal(getPatternsForCompany("b").length, 1);
  });

  it("resetPatternStore clears all", async () => {
    setPatternLearnerDeps(sequenceDeps([[1, 0, 0, 0]]));
    await extractPattern(makeObservation());
    assert.ok(getPatternCount() > 0);
    resetPatternStore();
    assert.equal(getPatternCount(), 0);
  });
});
