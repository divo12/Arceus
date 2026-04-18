import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "./governance-gateway";
import type { PolicyRule, PolicyEvalContext } from "@arceus/contracts";

// ── Helpers ────────────────────────────────────────────────

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: "test-rule",
    name: "Test Rule",
    description: "A test rule",
    appliesTo: [],
    toolPatterns: [],
    minTrust: 0,
    decision: "allow",
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PolicyEvalContext> = {}): PolicyEvalContext {
  return {
    agentId: "agent_tester",
    role: "tester",
    tool: "write",
    trustScore: 0.9,
    companyId: "c1",
    ...overrides,
  };
}

// ── Tests: file-pattern enforcement (Spec 21) ─────────────

describe("evaluatePolicy — filePattern enforcement", () => {
  // Two rules mirroring base-policies: deny write (500), allow test files (550)
  const denyWrite = makeRule({
    id: "tester-no-code-write",
    name: "Tester: No Code Write",
    appliesTo: ["tester"],
    toolPatterns: ["write", "apply_patch"],
    decision: "deny",
    priority: 500,
  });

  const allowTestFiles = makeRule({
    id: "tester-write-tests-only",
    name: "Tester: Write Tests Only",
    appliesTo: ["tester"],
    toolPatterns: ["write", "edit", "apply_patch"],
    decision: "allow",
    priority: 550,
    filePattern: "\\.(test|spec)\\.",
  });

  // Sorted by priority descending (highest first)
  const rules = [allowTestFiles, denyWrite];

  it("allows tester to write test files (*.test.*)", () => {
    const ctx = makeCtx({ tool: "write", filePath: "src/auth.test.ts" });
    const result = evaluatePolicy(ctx, rules);
    assert.equal(result.decision, "allow");
    assert.equal(result.ruleId, "tester-write-tests-only");
  });

  it("allows tester to write spec files (*.spec.*)", () => {
    const ctx = makeCtx({ tool: "write", filePath: "src/auth.spec.ts" });
    const result = evaluatePolicy(ctx, rules);
    assert.equal(result.decision, "allow");
    assert.equal(result.ruleId, "tester-write-tests-only");
  });

  it("denies tester writing production files", () => {
    const ctx = makeCtx({ tool: "write", filePath: "src/auth.ts" });
    const result = evaluatePolicy(ctx, rules);
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "tester-no-code-write");
  });

  it("allows tester write with no filePath (Phase 1 optimistic — runtime enforces)", () => {
    // No filePath → optimistic match so filterToolsForAgent includes the tool.
    // Runtime calls with actual filePath do the real enforcement.
    const ctx = makeCtx({ tool: "write" });
    const result = evaluatePolicy(ctx, rules);
    assert.equal(result.decision, "allow");
    assert.equal(result.ruleId, "tester-write-tests-only");
  });

  it("filePattern has no effect on rules without it", () => {
    // A rule with no filePattern still matches regardless of filePath
    const genericAllow = makeRule({
      id: "generic-allow",
      appliesTo: ["developer"],
      toolPatterns: ["write"],
      decision: "allow",
      priority: 100,
    });
    const ctx = makeCtx({ role: "developer", tool: "write", filePath: "src/main.ts" });
    const result = evaluatePolicy(ctx, [genericAllow]);
    assert.equal(result.decision, "allow");
    assert.equal(result.ruleId, "generic-allow");
  });

  it("apply_patch to test file is allowed", () => {
    const ctx = makeCtx({ tool: "apply_patch", filePath: "tests/unit.test.js" });
    const result = evaluatePolicy(ctx, rules);
    assert.equal(result.decision, "allow");
    assert.equal(result.ruleId, "tester-write-tests-only");
  });

  it("apply_patch to production file is denied", () => {
    const ctx = makeCtx({ tool: "apply_patch", filePath: "src/server.ts" });
    const result = evaluatePolicy(ctx, rules);
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "tester-no-code-write");
  });
});
