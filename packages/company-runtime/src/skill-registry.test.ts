import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerSkill,
  updateSkill,
  deprecateSkill,
  getSkillById,
  getSkillsForRole,
  getAllSkills,
  getSkillHistory,
  matchSkills,
  recordSkillUsage,
  updateSuccessRate,
  getSkillHealth,
  seedExistingSkills,
  isSeeded,
  resetRegistry,
  getRegistrySize,
} from "./skill-registry";
import type { SkillArtifact } from "@arceus/contracts";
import { resolve } from "node:path";

// ── Helpers ────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillArtifact> = {}): SkillArtifact {
  return {
    id: `skill-test-${Math.random().toString(36).slice(2)}`,
    companyId: "company_test",
    name: "Test Skill",
    role: "developer",
    version: 1,
    status: "active",
    trigger: "When implementing test features",
    content: "# Test Skill\n\nDo the thing.",
    testCases: [],
    resources: [],
    successRate: 0.7,
    usageCount: 0,
    lastUsedAt: null,
    mutatedFromId: null,
    mutatedBy: null,
    mutationReason: null,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("Skill Registry — CRUD", () => {
  beforeEach(() => resetRegistry());

  it("registers and retrieves a skill", () => {
    const skill = makeSkill({ id: "skill-crud-1" });
    registerSkill(skill);
    const found = getSkillById("skill-crud-1");
    assert.ok(found);
    assert.equal(found.name, "Test Skill");
  });

  it("updates a skill", () => {
    const skill = makeSkill({ id: "skill-update-1" });
    registerSkill(skill);
    const updated = updateSkill("skill-update-1", { successRate: 0.95 });
    assert.ok(updated);
    assert.equal(updated.successRate, 0.95);
    assert.equal(getSkillById("skill-update-1")!.successRate, 0.95);
  });

  it("deprecates a skill", () => {
    const skill = makeSkill({ id: "skill-dep-1" });
    registerSkill(skill);
    const result = deprecateSkill("skill-dep-1", "Replaced by v2");
    assert.equal(result, true);
    assert.equal(getSkillById("skill-dep-1")!.status, "deprecated");
    // Deprecated skills don't appear in getSkillsForRole
    assert.equal(getSkillsForRole("company_test", "developer").length, 0);
  });

  it("returns null for unknown skill", () => {
    assert.equal(getSkillById("nonexistent"), null);
    assert.equal(updateSkill("nonexistent", {}), null);
    assert.equal(deprecateSkill("nonexistent", "test"), false);
  });
});

describe("Skill Registry — Query", () => {
  beforeEach(() => resetRegistry());

  it("getSkillsForRole returns only active skills for the role", () => {
    registerSkill(makeSkill({ id: "s1", role: "developer", status: "active" }));
    registerSkill(makeSkill({ id: "s2", role: "developer", status: "deprecated" }));
    registerSkill(makeSkill({ id: "s3", role: "tester", status: "active" }));

    const devSkills = getSkillsForRole("company_test", "developer");
    assert.equal(devSkills.length, 1);
    assert.equal(devSkills[0].id, "s1");

    const testerSkills = getSkillsForRole("company_test", "tester");
    assert.equal(testerSkills.length, 1);
    assert.equal(testerSkills[0].id, "s3");
  });

  it("getAllSkills returns all skills for a company", () => {
    registerSkill(makeSkill({ id: "s1", companyId: "c1" }));
    registerSkill(makeSkill({ id: "s2", companyId: "c1", status: "deprecated" }));
    registerSkill(makeSkill({ id: "s3", companyId: "c2" }));

    assert.equal(getAllSkills("c1").length, 2);
    assert.equal(getAllSkills("c2").length, 1);
    assert.equal(getAllSkills("c3").length, 0);
  });

  it("getSkillHistory returns versions sorted ascending", () => {
    registerSkill(makeSkill({ id: "s-v2", name: "JWT Auth", version: 2 }));
    registerSkill(makeSkill({ id: "s-v1", name: "JWT Auth", version: 1 }));
    registerSkill(makeSkill({ id: "s-v3", name: "JWT Auth", version: 3 }));

    const history = getSkillHistory("company_test", "JWT Auth");
    assert.equal(history.length, 3);
    assert.equal(history[0].version, 1);
    assert.equal(history[1].version, 2);
    assert.equal(history[2].version, 3);
  });
});

describe("Skill Registry — matchSkills", () => {
  beforeEach(() => resetRegistry());

  it("matches skills by trigger token overlap", () => {
    registerSkill(makeSkill({
      id: "s-jwt",
      name: "JWT Auth",
      trigger: "When implementing JWT authentication or token-based auth",
    }));
    registerSkill(makeSkill({
      id: "s-api",
      name: "API Patterns",
      trigger: "When creating API endpoints or REST routes",
    }));

    const matched = matchSkills("company_test", "developer", "Implement JWT authentication for login");
    assert.ok(matched.length >= 1);
    assert.equal(matched[0].id, "s-jwt");
  });

  it("returns empty for no overlap", () => {
    registerSkill(makeSkill({
      id: "s-jwt",
      trigger: "When implementing JWT authentication",
    }));

    const matched = matchSkills("company_test", "developer", "Design the database schema");
    assert.equal(matched.length, 0);
  });

  it("returns max 3 skills", () => {
    for (let i = 0; i < 5; i++) {
      registerSkill(makeSkill({
        id: `s-${i}`,
        name: `Skill ${i}`,
        trigger: "When building frontend components",
      }));
    }

    const matched = matchSkills("company_test", "developer", "Build frontend component for dashboard");
    assert.ok(matched.length <= 3);
  });

  it("does not match skills for wrong role", () => {
    registerSkill(makeSkill({
      id: "s-test",
      role: "tester",
      trigger: "When testing web applications",
    }));

    const matched = matchSkills("company_test", "developer", "Test the web application");
    assert.equal(matched.length, 0);
  });
});

describe("Skill Registry — Usage tracking", () => {
  beforeEach(() => resetRegistry());

  it("recordSkillUsage increments count and sets lastUsedAt", () => {
    registerSkill(makeSkill({ id: "s1", usageCount: 0, lastUsedAt: null }));
    recordSkillUsage("s1");
    const skill = getSkillById("s1")!;
    assert.equal(skill.usageCount, 1);
    assert.ok(skill.lastUsedAt);
  });

  it("updateSuccessRate applies EMA", () => {
    registerSkill(makeSkill({ id: "s1", successRate: 0.7 }));
    // EMA: 0.7 * 0.85 + 1.0 * 0.15 = 0.595 + 0.15 = 0.745
    updateSuccessRate("s1", 1.0);
    const rate = getSkillById("s1")!.successRate;
    assert.ok(Math.abs(rate - 0.745) < 0.001, `Expected ~0.745, got ${rate}`);
  });

  it("updateSuccessRate clamps to [0, 1]", () => {
    registerSkill(makeSkill({ id: "s1", successRate: 0.05 }));
    updateSuccessRate("s1", 0.0);
    assert.ok(getSkillById("s1")!.successRate >= 0);

    registerSkill(makeSkill({ id: "s2", successRate: 0.99 }));
    updateSuccessRate("s2", 1.0);
    assert.ok(getSkillById("s2")!.successRate <= 1.0);
  });
});

describe("Skill Registry — Health", () => {
  beforeEach(() => resetRegistry());

  it("returns correct health metrics", () => {
    registerSkill(makeSkill({ id: "s1", successRate: 0.9, status: "active" }));
    registerSkill(makeSkill({ id: "s2", successRate: 0.4, status: "active" }));
    registerSkill(makeSkill({ id: "s3", successRate: 0.8, status: "deprecated" }));

    const health = getSkillHealth("company_test");
    assert.equal(health.totalSkills, 3);
    assert.equal(health.activeSkills, 2);
    assert.ok(health.averageSuccessRate > 0.6);
    assert.equal(health.worstPerformers.length, 1);
    assert.equal(health.worstPerformers[0].skillId, "s2");
  });
});

describe("Skill Registry — Seed", () => {
  beforeEach(() => resetRegistry());

  it("seeds skills from the skills directory", () => {
    const skillsDir = resolve(process.cwd(), "packages", "company-runtime", "skills");
    const count = seedExistingSkills("company_seed_test", skillsDir);
    assert.ok(count >= 6, `Expected at least 6 skills seeded, got ${count}`);
    assert.equal(isSeeded(), true);

    // Check specific skills exist
    const devSkills = getSkillsForRole("company_seed_test", "developer");
    assert.ok(devSkills.length >= 1, "Developer should have at least 1 skill");

    const testerSkills = getSkillsForRole("company_seed_test", "tester");
    assert.ok(testerSkills.length >= 1, "Tester should have at least 1 skill");
  });

  it("is idempotent — second call returns 0", () => {
    const skillsDir = resolve(process.cwd(), "packages", "company-runtime", "skills");
    seedExistingSkills("company_seed_test", skillsDir);
    const count2 = seedExistingSkills("company_seed_test", skillsDir);
    assert.equal(count2, 0);
  });

  it("seeded skills have correct structure", () => {
    const skillsDir = resolve(process.cwd(), "packages", "company-runtime", "skills");
    seedExistingSkills("company_struct_test", skillsDir);

    const all = getAllSkills("company_struct_test");
    for (const skill of all) {
      assert.ok(skill.id, "Skill should have an id");
      assert.ok(skill.name, "Skill should have a name");
      assert.ok(skill.role, "Skill should have a role");
      assert.equal(skill.version, 1, "Seeded skills should be v1");
      assert.equal(skill.status, "active", "Seeded skills should be active");
      assert.ok(skill.trigger, "Skill should have a trigger");
      assert.ok(skill.content.length > 10, "Skill should have content");
      assert.equal(skill.successRate, 0.7, "Seeded skills start at 0.7");
    }
  });
});
