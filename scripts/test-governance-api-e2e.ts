/**
 * End-to-end test: Governance API Endpoints
 *
 * Requires a running API server at http://localhost:4000.
 * Tests all 6 governance endpoints with real HTTP requests.
 *
 * Tests:
 *  1. GET /api/governance/policies → 11 rules
 *  2. GET /api/governance/stats → correct shape
 *  3. GET /api/governance/trust-scores → array
 *  4. GET /api/governance/trust-scores/:agentId → creates initial trust
 *  5. POST /api/governance/trust-scores/:agentId/adjust → modifies score
 *  6. GET /api/governance/violations → array
 *  7. Trust adjustment → score changes correctly
 *  8. Violation penalty → score decreases after violation event
 *  9. GET /api/governance/trust-scores/:agentId → reflects updated score
 *
 * Usage: npx tsx scripts/test-governance-api-e2e.ts
 */

const BASE_URL = process.env.API_URL ?? "http://localhost:4000";

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

async function fetchJSON(path: string, opts?: RequestInit) {
  const url = `${BASE_URL}${path}`;
  console.log(`    → ${opts?.method ?? "GET"} ${url}`);
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ── Connectivity check ─────────────────────────────────────

async function checkServer() {
  console.log("\n🔌 Checking API server connectivity...");
  try {
    const res = await fetch(`${BASE_URL}/api/governance/policies`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      console.log(`  ✅ Server reachable at ${BASE_URL}\n`);
      return true;
    }
  } catch {
    // fall through
  }
  console.error(`  ❌ Cannot reach server at ${BASE_URL}`);
  console.error(`     Start the API server first: npm run dev:api\n`);
  return false;
}

// ── Test 1: Policies endpoint ──────────────────────────────

async function testPolicies() {
  console.log("\n🧪 Test 1: GET /api/governance/policies");

  const { status, body } = await fetchJSON("/api/governance/policies");
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(Array.isArray(body), "Response is array");
  assert(body.length === 11, `11 policy rules (got: ${body.length})`);

  // Check first rule shape
  const rule = body[0];
  assert("id" in rule, "Rule has id");
  assert("name" in rule, "Rule has name");
  assert("priority" in rule, "Rule has priority");
  assert("decision" in rule, "Rule has decision");
  assert("toolPatterns" in rule, "Rule has toolPatterns");
  assert("appliesTo" in rule, "Rule has appliesTo");

  // Verify sorted by priority desc
  for (let i = 1; i < body.length; i++) {
    assert(body[i - 1].priority >= body[i].priority, `Rule ${i - 1} priority ≥ rule ${i}`);
  }

  console.log(`    📋 Rules: ${body.map((r: any) => r.id).join(", ")}`);
}

// ── Test 2: Stats endpoint ─────────────────────────────────

async function testStats() {
  console.log("\n🧪 Test 2: GET /api/governance/stats");

  const { status, body } = await fetchJSON("/api/governance/stats");
  assert(status === 200, `Status 200 (got: ${status})`);
  assert("agentCount" in body, "Has agentCount");
  assert("trustScoreCount" in body, "Has trustScoreCount");
  assert("averageTrust" in body, "Has averageTrust");
  assert("tierDistribution" in body, "Has tierDistribution");
  assert("recentViolations" in body, "Has recentViolations");
  assert("violationsBySeverity" in body, "Has violationsBySeverity");
  assert("policyCount" in body, "Has policyCount");
  assert(body.policyCount === 11, `policyCount is 11 (got: ${body.policyCount})`);

  // Tier distribution shape
  const td = body.tierDistribution;
  assert("autonomous" in td, "tierDistribution has autonomous");
  assert("trusted" in td, "tierDistribution has trusted");
  assert("standard" in td, "tierDistribution has standard");
  assert("restricted" in td, "tierDistribution has restricted");
  assert("critical" in td, "tierDistribution has critical");

  console.log(`    📊 Stats: ${body.agentCount} agents, avg trust ${body.averageTrust.toFixed(3)}, ${body.recentViolations} violations`);
}

// ── Test 3: All trust scores ───────────────────────────────

async function testAllTrustScores() {
  console.log("\n🧪 Test 3: GET /api/governance/trust-scores");

  const { status, body } = await fetchJSON("/api/governance/trust-scores");
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(Array.isArray(body), "Response is array");
  console.log(`    📊 ${body.length} trust score(s) in cache`);
}

// ── Test 4: Single agent trust (creates initial) ───────────

async function testSingleTrustScore() {
  console.log("\n🧪 Test 4: GET /api/governance/trust-scores/:agentId (creates initial)");

  const testAgent = `test_agent_${Date.now()}`;
  const { status, body } = await fetchJSON(`/api/governance/trust-scores/${testAgent}`);
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(body.agentId === testAgent, `agentId matches (got: ${body.agentId})`);
  assert(body.score === 0.7, `Initial score is 0.7 (got: ${body.score})`);
  assert(body.tier === "trusted", `Initial tier is "trusted" (got: ${body.tier})`);
  assert(Array.isArray(body.history), "Has history array");

  return testAgent; // return for subsequent tests
}

// ── Test 5: Adjust trust (manual) ──────────────────────────

async function testAdjustTrust(agentId: string) {
  console.log("\n🧪 Test 5: POST /api/governance/trust-scores/:agentId/adjust");

  // Boost the agent by +0.1
  const { status, body } = await fetchJSON(`/api/governance/trust-scores/${agentId}/adjust`, {
    method: "POST",
    body: JSON.stringify({
      kind: "manual_adjustment",
      reason: "E2E test boost",
      delta: 0.1,
    }),
  });
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(Math.abs(body.score - 0.8) < 0.001, `Score now 0.8 (got: ${body.score})`);
  assert(body.tier === "trusted", `Still trusted at 0.8 (got: ${body.tier})`);

  return body.score;
}

// ── Test 6: Violations endpoint ────────────────────────────

async function testViolations() {
  console.log("\n🧪 Test 6: GET /api/governance/violations");

  const { status, body } = await fetchJSON("/api/governance/violations");
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(Array.isArray(body), "Response is array");
  console.log(`    📊 ${body.length} violation(s)`);
}

// ── Test 7: Task completed adjustment ──────────────────────

async function testTaskCompletedAdjust(agentId: string, previousScore: number) {
  console.log("\n🧪 Test 7: Task completed → score increases");

  const { status, body } = await fetchJSON(`/api/governance/trust-scores/${agentId}/adjust`, {
    method: "POST",
    body: JSON.stringify({
      kind: "task_completed",
      reason: "E2E test: simulated task completion",
    }),
  });
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(body.score > previousScore, `Score increased from ${previousScore} to ${body.score}`);
  const expectedScore = previousScore + 0.02;
  assert(
    Math.abs(body.score - expectedScore) < 0.001,
    `Score is ${expectedScore.toFixed(3)} (got: ${body.score.toFixed(3)})`,
  );

  return body.score;
}

// ── Test 8: Violation penalty ──────────────────────────────

async function testViolationPenalty(agentId: string, previousScore: number) {
  console.log("\n🧪 Test 8: Violation event → score decreases");

  const { status, body } = await fetchJSON(`/api/governance/trust-scores/${agentId}/adjust`, {
    method: "POST",
    body: JSON.stringify({
      kind: "violation",
      reason: "E2E test: simulated policy violation",
    }),
  });
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(body.score < previousScore, `Score decreased from ${previousScore} to ${body.score}`);
  const expectedScore = Math.max(0, previousScore - 0.15);
  assert(
    Math.abs(body.score - expectedScore) < 0.001,
    `Score is ${expectedScore.toFixed(3)} (got: ${body.score.toFixed(3)})`,
  );

  return body.score;
}

// ── Test 9: Verify updated score persists ──────────────────

async function testScorePersisted(agentId: string, expectedScore: number) {
  console.log("\n🧪 Test 9: GET trust score reflects all adjustments");

  const { status, body } = await fetchJSON(`/api/governance/trust-scores/${agentId}`);
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(
    Math.abs(body.score - expectedScore) < 0.001,
    `Score matches expected ${expectedScore.toFixed(3)} (got: ${body.score.toFixed(3)})`,
  );
  assert(body.history.length >= 4, `History has ≥4 entries (got: ${body.history.length})`);

  console.log(`    📊 Final: score=${body.score.toFixed(3)}, tier=${body.tier}, history=${body.history.length} entries`);
}

// ── Test 10: Violations with agentId filter ────────────────

async function testViolationsFilter() {
  console.log("\n🧪 Test 10: GET /api/governance/violations?limit=5");

  const { status, body } = await fetchJSON("/api/governance/violations?limit=5");
  assert(status === 200, `Status 200 (got: ${status})`);
  assert(Array.isArray(body), "Response is array");
  assert(body.length <= 5, `Respects limit=5 (got: ${body.length})`);
}

// ── Test 11: Missing kind/reason → error ───────────────────

async function testAdjustValidation() {
  console.log("\n🧪 Test 11: POST adjust with missing fields → error");

  const { body } = await fetchJSON("/api/governance/trust-scores/test_agent/adjust", {
    method: "POST",
    body: JSON.stringify({ reason: "no kind" }),
  });
  assert("error" in body, 'Missing kind → returns error');

  const { body: body2 } = await fetchJSON("/api/governance/trust-scores/test_agent/adjust", {
    method: "POST",
    body: JSON.stringify({ kind: "manual_adjustment" }),
  });
  assert("error" in body2, 'Missing reason → returns error');
}

// ── Runner ─────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Spec 13 — Governance API E2E Tests                ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  const reachable = await checkServer();
  if (!reachable) {
    console.log("⏭  Skipping API tests (server not running)");
    process.exit(0);
  }

  await testPolicies();
  await testStats();
  await testAllTrustScores();
  const agentId = await testSingleTrustScore();
  const scoreAfterBoost = await testAdjustTrust(agentId);
  await testViolations();
  const scoreAfterTask = await testTaskCompletedAdjust(agentId, scoreAfterBoost);
  const scoreAfterViolation = await testViolationPenalty(agentId, scoreAfterTask);
  await testScorePersisted(agentId, scoreAfterViolation);
  await testViolationsFilter();
  await testAdjustValidation();

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();
