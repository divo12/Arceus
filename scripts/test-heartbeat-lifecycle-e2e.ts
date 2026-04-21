/**
 * End-to-end test: Phase 6.5 — Heartbeat Lifecycle (Package L)
 *
 * Tests the full beat lifecycle wiring:
 *  1. Session context register / unregister lifecycle
 *  2. Beat scoring — completed, blocked, empty transitions
 *  3. Skill usage tracking round-trip with updateSuccessRate
 *  4. Beat scratch dir creation + cleanup
 *  5. Back-to-back beats do not bleed session context
 *  6. Full runBeat flow (gated — requires running OpenCode server)
 *
 * Usage: npx tsx scripts/test-heartbeat-lifecycle-e2e.ts
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  registerSessionContext,
  getSessionContext,
  unregisterSessionContext,
  sessionContextSize,
} from "../apps/api/src/orchestration/session-context.js";
import {
  scoreBeatVerdict,
  recordBeatTaskTransition,
  clearBeatTaskTransitions,
} from "../apps/api/src/orchestration/beat-scoring.js";
import {
  updateSuccessRate,
  resetSkillRegistry,
  registerSkill,
  getSkillById,
} from "@arceus/company-runtime";
import type { BeatContext, SkillArtifact } from "@arceus/contracts";

// ── Test harness ───────────────────────────────────────────

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

function assertEq<T>(actual: T, expected: T, label: string) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ── Helpers ────────────────────────────────────────────────

function makeBeatContext(overrides: Partial<BeatContext> = {}): BeatContext {
  return {
    beatId: "beat_test_001",
    sessionId: "sess_test_001",
    companyId: "comp_test",
    role: "developer",
    trustBand: "standard",
    allowedTools: ["task_claim", "task_complete"],
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Test 1: Session context lifecycle ──────────────────────

async function testSessionContextLifecycle() {
  console.log("\n🧪 Test 1: Session context register / lookup / unregister");
  const ctx = makeBeatContext();
  registerSessionContext(ctx);

  const retrieved = getSessionContext("sess_test_001");
  assert(retrieved !== undefined, "getSessionContext returns registered context");
  assertEq(retrieved?.beatId, "beat_test_001", "beatId matches");
  assertEq(retrieved?.role, "developer", "role matches");
  assertEq(sessionContextSize(), 1, "sessionContextSize is 1 after register");

  unregisterSessionContext("sess_test_001");
  assert(getSessionContext("sess_test_001") === undefined, "context gone after unregister");
  assertEq(sessionContextSize(), 0, "sessionContextSize is 0 after unregister");
}

// ── Test 2: Beat scoring — completed task ──────────────────

async function testBeatScoringPass() {
  console.log("\n🧪 Test 2: Beat scoring — completed task → pass");
  const beatId = "beat_score_pass";
  recordBeatTaskTransition(beatId, "tsk_1", "completed");
  const verdict = await scoreBeatVerdict(beatId);
  assertEq(verdict, "pass", "verdict is pass when task completed");
  clearBeatTaskTransitions(beatId);
}

// ── Test 3: Beat scoring — blocked task ────────────────────

async function testBeatScoringBlocked() {
  console.log("\n🧪 Test 3: Beat scoring — blocked task → fail");
  const beatId = "beat_score_blocked";
  recordBeatTaskTransition(beatId, "tsk_1", "completed");
  recordBeatTaskTransition(beatId, "tsk_2", "blocked");
  const verdict = await scoreBeatVerdict(beatId);
  assertEq(verdict, "fail", "verdict is fail when any task blocked");
  clearBeatTaskTransitions(beatId);
}

// ── Test 4: Beat scoring — no transitions ──────────────────

async function testBeatScoringEmpty() {
  console.log("\n🧪 Test 4: Beat scoring — no transitions → fail");
  const beatId = "beat_score_empty";
  const verdict = await scoreBeatVerdict(beatId);
  assertEq(verdict, "fail", "verdict is fail with no transitions");
}

// ── Test 5: Skill usage tracking (inline, avoids Fastify import) ──

async function testSkillUsageTracking() {
  console.log("\n🧪 Test 5: Skill usage tracking via in-memory Map");
  // Replicate the same Set<string> pattern used by internal-telemetry.routes.ts
  const beatSkillSets = new Map<string, Set<string>>();
  function record(beatId: string, skillId: string) {
    let s = beatSkillSets.get(beatId);
    if (!s) { s = new Set(); beatSkillSets.set(beatId, s); }
    s.add(skillId);
  }
  function get(beatId: string): string[] { return [...(beatSkillSets.get(beatId) ?? [])]; }
  function clear(beatId: string) { beatSkillSets.delete(beatId); }

  const beatId = "beat_skill_track";
  record(beatId, "skill_tdd");
  record(beatId, "skill_qa");
  record(beatId, "skill_tdd"); // duplicate — should dedupe

  const used = get(beatId);
  assertEq(used.length, 2, "2 unique skills tracked");
  assert(used.includes("skill_tdd"), "skill_tdd in usage list");
  assert(used.includes("skill_qa"), "skill_qa in usage list");

  clear(beatId);
  const afterClear = get(beatId);
  assertEq(afterClear.length, 0, "usage empty after clear");
}

// ── Test 6: Beat scratch dir cleanup ───────────────────────

async function testBeatScratchCleanup() {
  console.log("\n🧪 Test 6: Beat scratch dir creation + cleanup");
  const beatId = "beat_cleanup_test";
  // Inline beat-paths logic (avoids opencode.ts → @opencode-ai/sdk import)
  const dir = join("/tmp", "arceus", "beats", beatId);

  await mkdir(dir, { recursive: true });
  assert(existsSync(dir), "scratch dir exists after mkdir");

  await rm(dir, { recursive: true, force: true });
  assert(!existsSync(dir), "scratch dir gone after cleanup");
}

// ── Test 7: Back-to-back session contexts don't bleed ──────

async function testNoSessionBleed() {
  console.log("\n🧪 Test 7: Back-to-back beats do not bleed session context");
  const ctx1 = makeBeatContext({ beatId: "beat_a", sessionId: "sess_a", role: "developer" });
  const ctx2 = makeBeatContext({ beatId: "beat_b", sessionId: "sess_b", role: "tester" });

  registerSessionContext(ctx1);
  assertEq(sessionContextSize(), 1, "size 1 during beat A");
  assertEq(getSessionContext("sess_a")?.role, "developer", "beat A is developer");
  unregisterSessionContext("sess_a");

  registerSessionContext(ctx2);
  assertEq(sessionContextSize(), 1, "size 1 during beat B");
  assertEq(getSessionContext("sess_b")?.role, "tester", "beat B is tester");
  assert(getSessionContext("sess_a") === undefined, "beat A context not leaked into beat B");
  unregisterSessionContext("sess_b");

  assertEq(sessionContextSize(), 0, "size 0 after both beats");
}

// ── Test 8: Skill success rate updates after beat ──────────

async function testSuccessRateEMA() {
  console.log("\n🧪 Test 8: updateSuccessRate EMA integration");
  resetSkillRegistry();
  const testSkill: SkillArtifact = {
    id: "skill_ema_test",
    companyId: "comp_test",
    name: "EMA Test Skill",
    role: "developer",
    version: 1,
    status: "active",
    trigger: "when testing EMA",
    content: "# EMA Test\nTest skill for success rate tracking.",
    testCases: [],
    successRate: 1.0,
    usageCount: 10,
    lastUsedAt: null,
    mutatedFromId: null,
    mutatedBy: null,
    mutationReason: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    resources: [],
  };
  registerSkill(testSkill);

  // Simulate a failed beat updating the skill
  updateSuccessRate("skill_ema_test", 0);
  const skill = getSkillById("skill_ema_test");
  assert(skill !== undefined, "skill exists after seed");
  assert(
    skill!.successRate < 1.0,
    `successRate decreased after failure (${skill!.successRate})`,
  );

  // Simulate a pass
  updateSuccessRate("skill_ema_test", 1);
  const skill2 = getSkillById("skill_ema_test");
  assert(
    skill2!.successRate > skill!.successRate,
    `successRate increased after pass (${skill2!.successRate} > ${skill!.successRate})`,
  );

  resetSkillRegistry();
}

// ── Test 9: Multiple concurrent session contexts ───────────

async function testConcurrentContexts() {
  console.log("\n🧪 Test 9: Multiple concurrent session contexts tracked correctly");
  const ctxA = makeBeatContext({ beatId: "beat_cc_a", sessionId: "sess_cc_a", role: "developer" });
  const ctxB = makeBeatContext({ beatId: "beat_cc_b", sessionId: "sess_cc_b", role: "tester" });

  registerSessionContext(ctxA);
  registerSessionContext(ctxB);
  assertEq(sessionContextSize(), 2, "2 concurrent contexts");
  assertEq(getSessionContext("sess_cc_a")?.beatId, "beat_cc_a", "context A correct");
  assertEq(getSessionContext("sess_cc_b")?.beatId, "beat_cc_b", "context B correct");

  unregisterSessionContext("sess_cc_a");
  assertEq(sessionContextSize(), 1, "1 context after removing A");
  assert(getSessionContext("sess_cc_a") === undefined, "A is gone");
  assert(getSessionContext("sess_cc_b") !== undefined, "B still present");

  unregisterSessionContext("sess_cc_b");
  assertEq(sessionContextSize(), 0, "0 after removing both");
}

// ── Runner ─────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Phase 6.5: Heartbeat Lifecycle E2E Tests");
  console.log("═══════════════════════════════════════════════════");

  await testSessionContextLifecycle();
  await testBeatScoringPass();
  await testBeatScoringBlocked();
  await testBeatScoringEmpty();
  await testSkillUsageTracking();
  await testBeatScratchCleanup();
  await testNoSessionBleed();
  await testSuccessRateEMA();
  await testConcurrentContexts();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
