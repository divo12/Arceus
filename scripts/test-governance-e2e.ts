/**
 * End-to-end test: Spec 13 — Governance Gateway + Trust Factor
 *
 * Tests (pure functions — no DB or server required):
 *  1. Trust factor lifecycle: create → adjust → tiers
 *  2. Policy evaluation: role-based deny, trust-gated deny, escalation, default allow
 *  3. filterToolsForAgent: developer, CEO, low-trust agent, tester
 *  4. toOpenCodeToolsParam conversion
 *  5. summarizeFilterResult logging
 *  6. Compliance bonus accumulation
 *  7. Trust score clamping at boundaries (0 and 1)
 *  8. buildTrustEvent helper
 *  9. End-to-end scenario: agent degrades from trusted → critical over violations
 *
 * Usage: npx tsx scripts/test-governance-e2e.ts
 */

import {
  TRUST_CONFIG,
  TRUST_TIER_THRESHOLDS,
  createInitialTrust,
  adjustTrust,
  applyComplianceBonus,
  getTrustTier,
  getTrustTierLabel,
  buildTrustEvent,
  BASE_POLICY_RULES,
  evaluatePolicy,
  filterToolsForAgent,
  toOpenCodeToolsParam,
  summarizeFilterResult,
} from "@arceus/company-runtime";
import type { TrustTier } from "@arceus/company-runtime";
import type { TrustScore, TrustEvent, PolicyEvalContext } from "@arceus/contracts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

const ALL_TOOLS = ["read", "glob", "grep", "write", "edit", "apply_patch", "bash"];
const NOW = new Date().toISOString();

// ── Test 1: Trust Factor Lifecycle ─────────────────────────

async function testTrustLifecycle() {
  console.log("\n🧪 Test 1: Trust factor lifecycle");

  const trust = createInitialTrust("agent_dev_1", NOW);
  assert(trust.score === 0.7, `Initial score is 0.7 (got: ${trust.score})`);
  assert(trust.agentId === "agent_dev_1", "Agent ID set correctly");
  assert(trust.history.length === 1, "History has 1 entry");
  assert(getTrustTier(trust.score) === "trusted", `Tier is "trusted" (got: ${getTrustTier(trust.score)})`);

  // Task completed → +0.02
  const evt1 = buildTrustEvent("agent_dev_1", "task_completed", "Built login page", NOW);
  const trust2 = adjustTrust(trust, evt1);
  assert(Math.abs(trust2.score - 0.72) < 0.001, `After task_completed: 0.72 (got: ${trust2.score.toFixed(3)})`);
  assert(trust2.history.length === 2, "History has 2 entries");

  // Task failed → -0.05
  const evt2 = buildTrustEvent("agent_dev_1", "task_failed", "Tests broke", NOW);
  const trust3 = adjustTrust(trust2, evt2);
  assert(Math.abs(trust3.score - 0.67) < 0.001, `After task_failed: 0.67 (got: ${trust3.score.toFixed(3)})`);
  assert(getTrustTier(trust3.score) === "standard", `Tier dropped to "standard" (got: ${getTrustTier(trust3.score)})`);

  // Violation → -0.15
  const evt3 = buildTrustEvent("agent_dev_1", "violation", "Unauthorized shell use", NOW);
  const trust4 = adjustTrust(trust3, evt3);
  assert(Math.abs(trust4.score - 0.52) < 0.001, `After violation: 0.52 (got: ${trust4.score.toFixed(3)})`);

  // Escalation resolved → +0.03
  const evt4 = buildTrustEvent("agent_dev_1", "escalation_resolved", "Manager approved", NOW);
  const trust5 = adjustTrust(trust4, evt4);
  assert(Math.abs(trust5.score - 0.55) < 0.001, `After escalation_resolved: 0.55 (got: ${trust5.score.toFixed(3)})`);

  // Manual adjustment with custom delta
  const evt5 = buildTrustEvent("agent_dev_1", "manual_adjustment", "Admin boost", NOW, +0.1);
  const trust6 = adjustTrust(trust5, evt5);
  assert(Math.abs(trust6.score - 0.65) < 0.001, `After manual +0.1: 0.65 (got: ${trust6.score.toFixed(3)})`);
}

// ── Test 2: Policy Evaluation ──────────────────────────────

async function testPolicyEvaluation() {
  console.log("\n🧪 Test 2: Policy evaluation (single tool checks)");

  // CEO + bash → deny (ceo-no-code rule)
  const ceoBash: PolicyEvalContext = {
    agentId: "agent_ceo", role: "ceo", tool: "bash",
    trustScore: 0.9, companyId: "c1",
  };
  const d1 = evaluatePolicy(ceoBash, BASE_POLICY_RULES);
  assert(d1.decision === "deny", `CEO + bash → deny (got: ${d1.decision})`);
  assert(d1.ruleId === "ceo-no-code", `Matched rule: ceo-no-code (got: ${d1.ruleId})`);

  // CEO + read → allow (read-tools-allowed rule)
  const ceoRead: PolicyEvalContext = {
    agentId: "agent_ceo", role: "ceo", tool: "read",
    trustScore: 0.9, companyId: "c1",
  };
  const d2 = evaluatePolicy(ceoRead, BASE_POLICY_RULES);
  assert(d2.decision === "allow", `CEO + read → allow (got: ${d2.decision})`);

  // Developer (trust 0.2, critical) + write → deny (critical-trust-lockout)
  const devCritical: PolicyEvalContext = {
    agentId: "agent_dev", role: "developer", tool: "write",
    trustScore: 0.2, companyId: "c1",
  };
  const d3 = evaluatePolicy(devCritical, BASE_POLICY_RULES);
  assert(d3.decision === "deny", `Critical trust dev + write → deny (got: ${d3.decision})`);
  assert(d3.ruleId === "critical-trust-lockout", `Matched rule: critical-trust-lockout (got: ${d3.ruleId})`);

  // Developer (trust 0.4, restricted) + bash → escalate (restricted-trust-shell-escalate)
  const devRestricted: PolicyEvalContext = {
    agentId: "agent_dev", role: "developer", tool: "bash",
    trustScore: 0.4, companyId: "c1",
  };
  const d4 = evaluatePolicy(devRestricted, BASE_POLICY_RULES);
  assert(d4.decision === "escalate", `Restricted trust dev + bash → escalate (got: ${d4.decision})`);
  assert(d4.ruleId === "restricted-trust-shell-escalate", `Matched rule (got: ${d4.ruleId})`);

  // Developer (trust 0.6) + apply_patch → escalate (standard-trust-patch-escalate)
  const devStandard: PolicyEvalContext = {
    agentId: "agent_dev", role: "developer", tool: "apply_patch",
    trustScore: 0.6, companyId: "c1",
  };
  const d5 = evaluatePolicy(devStandard, BASE_POLICY_RULES);
  assert(d5.decision === "escalate", `Standard trust dev + apply_patch → escalate (got: ${d5.decision})`);

  // Developer (trust 0.9, autonomous) + bash → allow (default, no deny rule matches)
  const devAuto: PolicyEvalContext = {
    agentId: "agent_dev", role: "developer", tool: "bash",
    trustScore: 0.9, companyId: "c1",
  };
  const d6 = evaluatePolicy(devAuto, BASE_POLICY_RULES);
  assert(d6.decision === "allow", `Autonomous dev + bash → allow (got: ${d6.decision})`);

  // PM + write → deny
  const pmWrite: PolicyEvalContext = {
    agentId: "agent_pm", role: "pm", tool: "write",
    trustScore: 0.9, companyId: "c1",
  };
  const d7 = evaluatePolicy(pmWrite, BASE_POLICY_RULES);
  assert(d7.decision === "deny", `PM + write → deny (got: ${d7.decision})`);

  // Tester + write → allow (Spec 21: tester-write-tests-only carve-out)
  const testerWrite: PolicyEvalContext = {
    agentId: "agent_tester", role: "tester", tool: "write",
    trustScore: 0.9, companyId: "c1",
  };
  const d8 = evaluatePolicy(testerWrite, BASE_POLICY_RULES);
  assert(d8.decision === "allow", `Tester + write → allow (got: ${d8.decision})`);

  // ui_designer + bash → deny
  const uiBash: PolicyEvalContext = {
    agentId: "agent_ui", role: "ui_designer", tool: "bash",
    trustScore: 0.9, companyId: "c1",
  };
  const d9 = evaluatePolicy(uiBash, BASE_POLICY_RULES);
  assert(d9.decision === "deny", `UI Designer + bash → deny (got: ${d9.decision})`);

  // ui_designer + write → allow (no rule denies ui_designer code writes at high trust)
  const uiWrite: PolicyEvalContext = {
    agentId: "agent_ui", role: "ui_designer", tool: "write",
    trustScore: 0.9, companyId: "c1",
  };
  const d10 = evaluatePolicy(uiWrite, BASE_POLICY_RULES);
  assert(d10.decision === "allow", `UI Designer + write → allow (got: ${d10.decision})`);
}

// ── Test 3: filterToolsForAgent ────────────────────────────

async function testFilterTools() {
  console.log("\n🧪 Test 3: filterToolsForAgent for various roles");

  // Developer (trust 0.8, trusted) → should get all 7 tools
  const devResult = filterToolsForAgent(
    "developer", 0.8, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_dev",
  );
  assert(devResult.allowed.length === 7, `Trusted developer: all 7 tools (got: ${devResult.allowed.length})`);
  assert(devResult.denied.length === 0, `No denied tools (got: ${devResult.denied.length})`);
  assert(devResult.tier === "trusted", `Tier is trusted (got: ${devResult.tier})`);

  // CEO → read, glob, grep only (4 tools denied: write, edit, apply_patch, bash)
  const ceoResult = filterToolsForAgent(
    "ceo", 0.9, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_ceo",
  );
  assert(ceoResult.allowed.includes("read"), "CEO has read");
  assert(ceoResult.allowed.includes("glob"), "CEO has glob");
  assert(ceoResult.allowed.includes("grep"), "CEO has grep");
  assert(!ceoResult.allowed.includes("write"), "CEO denied write");
  assert(!ceoResult.allowed.includes("bash"), "CEO denied bash");
  assert(ceoResult.denied.length === 4, `CEO denied 4 tools (got: ${ceoResult.denied.length})`);

  // Developer (trust 0.2, critical) → only read tools allowed
  const critDevResult = filterToolsForAgent(
    "developer", 0.2, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_dev",
  );
  assert(critDevResult.allowed.length === 3, `Critical dev: only 3 read tools (got: ${critDevResult.allowed.length})`);
  assert(critDevResult.allowed.includes("read"), "Critical dev has read");
  assert(!critDevResult.allowed.includes("write"), "Critical dev denied write");
  assert(!critDevResult.allowed.includes("bash"), "Critical dev denied bash");

  // Developer (trust 0.4, restricted) → read + write + edit allowed, bash escalated
  const restDevResult = filterToolsForAgent(
    "developer", 0.4, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_dev",
  );
  assert(restDevResult.allowed.includes("read"), "Restricted dev has read");
  assert(restDevResult.allowed.includes("write"), "Restricted dev has write");
  assert(restDevResult.allowed.includes("edit"), "Restricted dev has edit");
  assert(restDevResult.escalated.some(d => d.tool === "bash"), "Restricted dev: bash escalated");
  assert(restDevResult.escalated.some(d => d.tool === "apply_patch"), "Restricted dev: apply_patch escalated");

  // Tester (trust 0.8) → read, glob, grep, edit, bash, write, apply_patch (Spec 21: write-tests-only carve-out)
  const testerResult = filterToolsForAgent(
    "tester", 0.8, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_tester",
  );
  assert(testerResult.allowed.includes("read"), "Tester has read");
  assert(testerResult.allowed.includes("bash"), "Tester has bash");
  assert(testerResult.allowed.includes("edit"), "Tester has edit");
  assert(testerResult.allowed.includes("write"), "Tester has write (tests-only carve-out)");
  assert(testerResult.allowed.includes("apply_patch"), "Tester has apply_patch (tests-only carve-out)");

  // Marketing → only read tools (like CEO)
  const mktResult = filterToolsForAgent(
    "marketing", 0.9, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_mkt",
  );
  assert(mktResult.allowed.length === 3, `Marketing: 3 read tools (got: ${mktResult.allowed.length})`);
  assert(mktResult.denied.length === 4, `Marketing: 4 denied (got: ${mktResult.denied.length})`);
}

// ── Test 4: toOpenCodeToolsParam ───────────────────────────

async function testToolsParam() {
  console.log("\n🧪 Test 4: toOpenCodeToolsParam conversion");

  const devResult = filterToolsForAgent(
    "developer", 0.8, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_dev",
  );
  const param = toOpenCodeToolsParam(devResult);
  assert(param !== undefined, "Param is defined for developer with tools");
  if (param) {
    assert(param["read"] === true, 'param["read"] is true');
    assert(param["bash"] === true, 'param["bash"] is true');
    assert(!("apply_patch_denied" in param), "No deny keys in param");
  }

  // Empty result → undefined
  const emptyResult = filterToolsForAgent(
    "developer", 0.2, [], BASE_POLICY_RULES, "c1", "agent_dev",
  );
  const emptyParam = toOpenCodeToolsParam(emptyResult);
  assert(emptyParam === undefined, "Empty tools → undefined param");
}

// ── Test 5: summarizeFilterResult ──────────────────────────

async function testSummarize() {
  console.log("\n🧪 Test 5: summarizeFilterResult logging output");

  const result = filterToolsForAgent(
    "ceo", 0.9, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_ceo",
  );
  const summary = summarizeFilterResult(result, "ceo");
  assert(summary.includes("[Governance]"), "Summary starts with [Governance]");
  assert(summary.includes("ceo"), "Summary includes role");
  assert(summary.includes("trust="), "Summary includes trust score");
  assert(summary.includes("tier="), "Summary includes tier");
  assert(summary.includes("allowed="), "Summary includes allowed tools");
  console.log(`    📝 ${summary}`);
}

// ── Test 6: Compliance bonus accumulation ──────────────────

async function testComplianceBonus() {
  console.log("\n🧪 Test 6: Compliance bonus accumulation");

  let trust = createInitialTrust("agent_dev_1", NOW); // 0.7
  // Apply 10 compliance bonuses
  for (let i = 0; i < 10; i++) {
    trust = applyComplianceBonus(trust, NOW);
  }
  // applyComplianceBonus uses kind=task_completed → adjustTrust uses config delta +0.02
  // 0.7 + 10 * 0.02 = 0.9
  assert(
    Math.abs(trust.score - 0.9) < 0.001,
    `10 compliance bonuses: 0.7 → 0.9 (got: ${trust.score.toFixed(3)})`,
  );
  assert(trust.history.length === 11, `History: 11 entries (got: ${trust.history.length})`);
  assert(getTrustTier(trust.score) === "autonomous", `Autonomous at 0.9 (got: ${getTrustTier(trust.score)})`);

  // 5 more → 0.9 + 5 * 0.02 = 1.0 (clamped)
  for (let i = 0; i < 5; i++) {
    trust = applyComplianceBonus(trust, NOW);
  }
  assert(trust.score === 1.0, `Clamped at 1.0 (got: ${trust.score})`);
  assert(getTrustTier(trust.score) === "autonomous", "Autonomous at 1.0");
}

// ── Test 7: Trust score boundary clamping ──────────────────

async function testBoundaryClamping() {
  console.log("\n🧪 Test 7: Trust score boundary clamping");

  // Drive to 0
  let trust = createInitialTrust("agent_bad", NOW);
  for (let i = 0; i < 10; i++) {
    const evt = buildTrustEvent("agent_bad", "violation", `Violation ${i}`, NOW);
    trust = adjustTrust(trust, evt);
  }
  assert(trust.score === 0, `Floor at 0.0 (got: ${trust.score})`);
  assert(getTrustTier(trust.score) === "critical", "Critical at 0.0");

  // Manual adjustment beyond 1
  const boost = buildTrustEvent("agent_bad", "manual_adjustment", "Admin full restore", NOW, +2.0);
  trust = adjustTrust(trust, boost);
  assert(trust.score === 1.0, `Ceiling at 1.0 (got: ${trust.score})`);
}

// ── Test 8: buildTrustEvent helper ─────────────────────────

async function testBuildTrustEvent() {
  console.log("\n🧪 Test 8: buildTrustEvent helper");

  const evt1 = buildTrustEvent("a1", "task_completed", "Done", NOW);
  assert(evt1.delta === TRUST_CONFIG.deltas.task_completed, `task_completed delta: ${evt1.delta}`);
  assert(evt1.kind === "task_completed", "kind set correctly");
  assert(evt1.agentId === "a1", "agentId set correctly");

  const evt2 = buildTrustEvent("a1", "manual_adjustment", "Custom", NOW, +0.25);
  assert(evt2.delta === 0.25, `Manual delta override: ${evt2.delta}`);

  const evt3 = buildTrustEvent("a1", "violation", "Bad", NOW);
  assert(evt3.delta === TRUST_CONFIG.deltas.violation, `Violation delta: ${evt3.delta}`);
}

// ── Test 9: Full degradation scenario ──────────────────────

async function testDegradationScenario() {
  console.log("\n🧪 Test 9: Agent degrades from trusted → critical over violations");

  let trust = createInitialTrust("agent_rogue", NOW);
  const tierHistory: string[] = [getTrustTier(trust.score)];

  // Simulate: 3 violations, interspersed with 1 completed task
  const events = [
    buildTrustEvent("agent_rogue", "violation", "Unauthorized file write", NOW),   // 0.7 → 0.55
    buildTrustEvent("agent_rogue", "task_completed", "Fixed bug", NOW),             // 0.55 → 0.57
    buildTrustEvent("agent_rogue", "violation", "Ran unapproved shell", NOW),       // 0.57 → 0.42
    buildTrustEvent("agent_rogue", "violation", "Accessed restricted path", NOW),   // 0.42 → 0.27
  ];

  for (const evt of events) {
    trust = adjustTrust(trust, evt);
    tierHistory.push(getTrustTier(trust.score));
  }

  console.log(`    📊 Tier progression: ${tierHistory.join(" → ")}`);
  console.log(`    📊 Final score: ${trust.score.toFixed(3)}`);

  assert(tierHistory[0] === "trusted", "Started trusted");
  assert(tierHistory[tierHistory.length - 1] === "critical", "Ended critical");
  assert(trust.score < 0.3, `Score below 0.3 (got: ${trust.score.toFixed(3)})`);

  // Now verify the critical agent's tool access
  const filter = filterToolsForAgent(
    "developer", trust.score, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_rogue",
  );
  assert(filter.allowed.length === 3, `Critical agent: only 3 read tools (got: ${filter.allowed.length})`);
  assert(filter.denied.length === 4, `4 destructive tools denied (got: ${filter.denied.length})`);
  assert(filter.tier === "critical", "Filter reports critical tier");

  console.log(`    📝 ${summarizeFilterResult(filter, "developer")}`);
}

// ── Test 10: Tier thresholds are correctly defined ─────────

async function testTierThresholds() {
  console.log("\n🧪 Test 10: Trust tier thresholds");

  assert(getTrustTier(1.0) === "autonomous", "1.0 → autonomous");
  assert(getTrustTier(0.95) === "autonomous", "0.95 → autonomous");
  assert(getTrustTier(0.9) === "autonomous", "0.9 → autonomous");
  assert(getTrustTier(0.89) === "trusted", "0.89 → trusted");
  assert(getTrustTier(0.7) === "trusted", "0.7 → trusted");
  assert(getTrustTier(0.69) === "standard", "0.69 → standard");
  assert(getTrustTier(0.5) === "standard", "0.5 → standard");
  assert(getTrustTier(0.49) === "restricted", "0.49 → restricted");
  assert(getTrustTier(0.3) === "restricted", "0.3 → restricted");
  assert(getTrustTier(0.29) === "critical", "0.29 → critical");
  assert(getTrustTier(0.0) === "critical", "0.0 → critical");
}

// ── Test 11: Policy rule count and ordering ────────────────

async function testPolicyRules() {
  console.log("\n🧪 Test 11: Policy rules configuration");

  assert(BASE_POLICY_RULES.length === 12, `12 base rules (got: ${BASE_POLICY_RULES.length})`);

  // Verify sorted by priority descending
  for (let i = 1; i < BASE_POLICY_RULES.length; i++) {
    assert(
      BASE_POLICY_RULES[i - 1].priority >= BASE_POLICY_RULES[i].priority,
      `Rule ${i - 1} priority (${BASE_POLICY_RULES[i - 1].priority}) ≥ rule ${i} (${BASE_POLICY_RULES[i].priority})`,
    );
  }

  // All rules have ids
  for (const rule of BASE_POLICY_RULES) {
    assert(rule.id !== "", `Rule "${rule.name}" has non-empty id`);
    // budget-exhausted is disabled (handled externally); all others enabled
    const expectedEnabled = rule.id === "budget-exhausted" ? false : true;
    assert(rule.enabled === expectedEnabled, `Rule "${rule.name}" enabled=${expectedEnabled}`);
  }
}

// ── Test 12: CTO-specific rules ────────────────────────────

async function testCTORules() {
  console.log("\n🧪 Test 12: CTO tool access");

  const ctoResult = filterToolsForAgent(
    "cto", 0.9, ALL_TOOLS, BASE_POLICY_RULES, "c1", "agent_cto",
  );
  assert(ctoResult.allowed.includes("read"), "CTO has read");
  assert(ctoResult.allowed.includes("edit"), "CTO has edit");
  assert(ctoResult.allowed.includes("bash"), "CTO has bash");
  assert(!ctoResult.allowed.includes("write"), "CTO denied write (no raw code)");
  assert(!ctoResult.allowed.includes("apply_patch"), "CTO denied apply_patch");
  console.log(`    📝 CTO tools: [${ctoResult.allowed.join(", ")}]`);
}

// ── Runner ─────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Spec 13 — Governance Gateway E2E Tests            ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  await testTrustLifecycle();
  await testPolicyEvaluation();
  await testFilterTools();
  await testToolsParam();
  await testSummarize();
  await testComplianceBonus();
  await testBoundaryClamping();
  await testBuildTrustEvent();
  await testDegradationScenario();
  await testTierThresholds();
  await testPolicyRules();
  await testCTORules();

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();
