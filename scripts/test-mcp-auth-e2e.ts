/**
 * End-to-end test: Spec 25 — Agent Auth & Idempotency
 *
 * Requires a running API server at http://localhost:4000.
 * Tests bearer auth, session-context identity, idempotency replay/conflict,
 * and the relaxed key format (colon-separated derived keys).
 *
 * Usage: npx tsx scripts/test-mcp-auth-e2e.ts
 */

import { createHash, randomUUID } from "node:crypto";

const BASE = process.env.API_URL ?? "http://localhost:4000";
const MCP = `${BASE}/api/internal/v1`;

// The dev-mode server falls back to "arceus-dev-token" when no
// ARCEUS_INTERNAL_TOKEN / ARCEUS_TOKEN ≥16 chars is set.
const DEV_TOKEN = process.env.ARCEUS_INTERNAL_TOKEN ?? "arceus-dev-token";

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

async function fetchMCP(path: string, opts: RequestInit & { headers?: Record<string, string> } = {}) {
  const res = await fetch(`${MCP}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...opts.headers,
    },
  });
  const text = await res.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;
  return { status: res.status, body, headers: res.headers };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${DEV_TOKEN}`,
    "x-beat-id": "beat_e2e_spec25",
    "x-company-id": "comp_e2e",
    "x-agent-role": "developer",
    ...extra,
  };
}

/** Same derivation as packages/arceus-mcp/src/envelope.ts */
function deriveKey(beatId: string, op: string, body: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(body ?? {}))
    .digest("hex")
    .slice(0, 16);
  return `${beatId}:${op}:${hash}`;
}

// ── Connectivity ───────────────────────────────────────────

async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/governance/policies`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

// ── Tests ──────────────────────────────────────────────────

async function testNoBearer() {
  console.log("\n🧪 Test 1: No bearer → 401");
  const { status, body } = await fetchMCP("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "x" }),
  });
  assert(status === 401, `Status 401 (got ${status})`);
  assert(body?.error?.cause === "governance", `Cause is governance`);
}

async function testBadBearer() {
  console.log("\n🧪 Test 2: Wrong bearer → 401");
  const { status } = await fetchMCP("/tasks", {
    method: "POST",
    headers: { authorization: "Bearer wrong-token-value!", "x-beat-id": "b", "x-company-id": "c", "x-agent-role": "developer" },
    body: JSON.stringify({ title: "x" }),
  });
  assert(status === 401, `Status 401 (got ${status})`);
}

async function testValidAuth() {
  console.log("\n🧪 Test 3: Valid bearer + headers → 201");
  const taskId = `tsk_e2e_${Date.now()}`;
  const { status, body } = await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders({ "idempotency-key": randomUUID() }),
    body: JSON.stringify({ id: taskId, title: "Spec 25 e2e task" }),
  });
  assert(status === 201, `Status 201 (got ${status})`);
  assert(body?.status === "success", `Body status is success`);
  assert(body?.data?.taskId === taskId, `Task ID matches`);
}

async function testNoIdempotencyKey() {
  console.log("\n🧪 Test 4: No idempotency key → request succeeds (no replay)");
  const { status, body } = await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title: "No idem key" }),
  });
  assert(status === 201, `Status 201 (got ${status})`);
  assert(body?.status === "success", `Body status is success`);
}

async function testDerivedIdempotencyKey() {
  console.log("\n🧪 Test 5: Derived idempotency key (colon-separated) accepted");
  const payload = { id: `tsk_derived_${Date.now()}`, title: "Derived key test" };
  const key = deriveKey("beat_e2e_spec25", "task_create", payload);
  assert(key.includes(":"), `Key contains colons: ${key}`);

  const { status, body } = await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders({ "idempotency-key": key }),
    body: JSON.stringify(payload),
  });
  assert(status === 201, `Status 201 (got ${status})`);
  assert(body?.status === "success", `Body status is success`);
}

async function testIdempotencyReplay() {
  console.log("\n🧪 Test 6: Idempotency replay — same key+body → cached 201");
  const payload = { id: `tsk_replay_${Date.now()}`, title: "Replay me" };
  const key = deriveKey("beat_e2e_spec25", "task_create", payload);

  const first = await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders({ "idempotency-key": key }),
    body: JSON.stringify(payload),
  });
  assert(first.status === 201, `First request 201 (got ${first.status})`);

  const second = await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders({ "idempotency-key": key }),
    body: JSON.stringify(payload),
  });
  assert(second.status === 201, `Replay returns 201 (got ${second.status})`);
  assert(
    JSON.stringify(first.body) === JSON.stringify(second.body),
    `Replay body matches original`,
  );
}

async function testIdempotencyConflict() {
  console.log("\n🧪 Test 7: Idempotency conflict — same key, different body → 409");
  const key = deriveKey("beat_e2e_spec25", "conflict", { n: Date.now() });

  await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders({ "idempotency-key": key }),
    body: JSON.stringify({ id: `tsk_c1_${Date.now()}`, title: "Body A" }),
  });

  const { status, body } = await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders({ "idempotency-key": key }),
    body: JSON.stringify({ id: `tsk_c2_${Date.now()}`, title: "Body B" }),
  });
  assert(status === 409, `Status 409 (got ${status})`);
  assert(body?.error?.cause === "conflict", `Cause is conflict`);
}

async function testMalformedKey() {
  console.log("\n🧪 Test 8: Malformed idempotency key → 422");
  const { status } = await fetchMCP("/tasks", {
    method: "POST",
    headers: authHeaders({ "idempotency-key": "ab" }), // too short
    body: JSON.stringify({ title: "bad key" }),
  });
  assert(status === 422, `Status 422 (got ${status})`);
}

async function testMissingIdentity() {
  console.log("\n🧪 Test 9: Missing identity headers → 422");
  const { status, body } = await fetchMCP("/tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${DEV_TOKEN}` }, // no beat/company/role
    body: JSON.stringify({ title: "no identity" }),
  });
  assert(status === 422, `Status 422 (got ${status})`);
  assert(body?.error?.cause === "validation", `Cause is validation`);
}

// ── Runner ─────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Spec 25 — Agent Auth & Idempotency E2E Tests      ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  const ok = await checkServer();
  if (!ok) {
    console.error(`\n  ❌ Cannot reach server at ${BASE}. Start API first.\n`);
    process.exit(1);
  }
  console.log(`  ✅ Server reachable at ${BASE}`);

  await testNoBearer();
  await testBadBearer();
  await testValidAuth();
  await testNoIdempotencyKey();
  await testDerivedIdempotencyKey();
  await testIdempotencyReplay();
  await testIdempotencyConflict();
  await testMalformedKey();
  await testMissingIdentity();

  console.log(`\n════════════════════════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
