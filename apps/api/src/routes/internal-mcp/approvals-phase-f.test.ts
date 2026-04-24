// Spec 28 Phase F — approvals: approval_get, approval_update, approval_decide.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";
import { bootstrapCompany, getSnapshot } from "../../persistence/store.js";

const TEST_TOKEN = "arceus-test-token-phase-f";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const headers = (role: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": "beat_phase_f",
  "x-company-id": "c_phase_f",
  "x-agent-role": role,
  "content-type": "application/json",
  ...extra,
});

const seedAgents = (...roles: string[]) => {
  const snap = getSnapshot();
  for (const role of roles) {
    snap.agents.push({ id: `agent_${role}`, role } as any);
  }
};

const bootstrap = () => {
  bootstrapCompany({ companyName: "PF Co", boardOwner: "owner", idea: "ship", budgetCents: 1000 } as any);
};

// ─── approval_get (single + list filters) ─────────────────

test("GET /approvals/:id 404 when missing", async () => {
  resetIdempotency();
  bootstrap();
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/approvals/missing",
    headers: headers("ceo"),
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET /approvals/:id returns the approval", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto");
  const app = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: {
      type: "tool_governance",
      requestedByRole: "cto",
      title: "Add new tool",
      description: "We need this tool.",
    },
  });
  assert.equal(created.statusCode, 201);
  const approvalId = created.json().data.approvalId;

  const res = await app.inject({
    method: "GET",
    url: `/api/internal/v1/approvals/${approvalId}`,
    headers: headers("ceo"),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.approval.id, approvalId);
  await app.close();
});

test("GET /approvals?pendingMyDecision=true as ceo excludes board-only types", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto", "ceo");
  const app = await buildApp();

  // Board-only: strategy
  await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("ceo", { "idempotency-key": randomUUID() }),
    payload: { type: "strategy", requestedByRole: "ceo", title: "Pivot", description: "Pivot now." },
  });
  // CEO-decidable: tool_governance
  const tg = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "cto", title: "Add tool", description: "Need it." },
  });
  const tgId = tg.json().data.approvalId;

  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/approvals?pendingMyDecision=true",
    headers: headers("ceo"),
  });
  assert.equal(res.statusCode, 200);
  const ids = res.json().data.approvals.map((a: { id: string }) => a.id);
  assert.ok(ids.includes(tgId));
  assert.ok(!res.json().data.approvals.some((a: { type: string }) => a.type === "strategy"));
  await app.close();
});

test("GET /approvals?pendingMyDecision=true as non-ceo returns empty", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto");
  const app = await buildApp();
  await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "cto", title: "T", description: "d" },
  });
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/approvals?pendingMyDecision=true",
    headers: headers("pm"),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.approvals.length, 0);
  await app.close();
});

test("GET /approvals?filedByMe=true returns only filer's approvals", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto", "pm");
  const app = await buildApp();
  await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "cto", title: "C", description: "d" },
  });
  await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("pm", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "pm", title: "P", description: "d" },
  });
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/approvals?filedByMe=true",
    headers: headers("cto"),
  });
  assert.equal(res.statusCode, 200);
  const titles = res.json().data.approvals.map((a: { title: string }) => a.title);
  assert.deepEqual(titles.sort(), ["C"]);
  await app.close();
});

// ─── approval_update (PATCH) ──────────────────────────────

test("PATCH /approvals/:id 404 when missing", async () => {
  resetIdempotency();
  bootstrap();
  const app = await buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: "/api/internal/v1/approvals/missing",
    headers: headers("cto"),
    payload: { title: "x" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("PATCH /approvals/:id by non-filer is forbidden", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto", "pm");
  const app = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "cto", title: "T", description: "d" },
  });
  const id = created.json().data.approvalId;
  const res = await app.inject({
    method: "PATCH",
    url: `/api/internal/v1/approvals/${id}`,
    headers: headers("pm"),
    payload: { title: "hacked" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.cause, "governance");
  await app.close();
});

test("PATCH /approvals/:id by filer updates fields", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto");
  const app = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "cto", title: "Old", description: "old desc" },
  });
  const id = created.json().data.approvalId;

  const res = await app.inject({
    method: "PATCH",
    url: `/api/internal/v1/approvals/${id}`,
    headers: headers("cto"),
    payload: { title: "New title", description: "new desc" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.approval.title, "New title");
  assert.equal(res.json().data.approval.description, "new desc");
  await app.close();
});

test("PATCH /approvals/:id 409 after decision", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto", "ceo");
  const app = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "cto", title: "T", description: "d" },
  });
  const id = created.json().data.approvalId;
  await app.inject({
    method: "POST",
    url: `/api/internal/v1/approvals/${id}/decide`,
    headers: headers("ceo", { "idempotency-key": randomUUID() }),
    payload: { decision: "approved" },
  });
  const res = await app.inject({
    method: "PATCH",
    url: `/api/internal/v1/approvals/${id}`,
    headers: headers("cto"),
    payload: { title: "late" },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});

// ─── approval_decide ──────────────────────────────────────

test("POST /approvals/:id/decide as non-ceo is forbidden", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto");
  const app = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { type: "tool_governance", requestedByRole: "cto", title: "T", description: "d" },
  });
  const id = created.json().data.approvalId;
  const res = await app.inject({
    method: "POST",
    url: `/api/internal/v1/approvals/${id}/decide`,
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: { decision: "approved" },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("POST /approvals/:id/decide on board-only type returns 403 not_authorized", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("ceo");
  const app = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("ceo", { "idempotency-key": randomUUID() }),
    payload: { type: "strategy", requestedByRole: "ceo", title: "Pivot", description: "d" },
  });
  const id = created.json().data.approvalId;
  const res = await app.inject({
    method: "POST",
    url: `/api/internal/v1/approvals/${id}/decide`,
    headers: headers("ceo", { "idempotency-key": randomUUID() }),
    payload: { decision: "approved" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.cause, "type_not_allowed");
  await app.close();
});

// ─── End-to-end exit criterion ────────────────────────────

test("e2e: CTO files architecture_change → CEO finds via pendingMyDecision → CEO decides approved", async () => {
  resetIdempotency();
  bootstrap();
  seedAgents("cto", "ceo");
  const app = await buildApp();

  const filed = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: {
      type: "architecture_change",
      requestedByRole: "cto",
      title: "Adopt Foo",
      description: "Switch to Foo for storage.",
    },
  });
  assert.equal(filed.statusCode, 201);
  const approvalId = filed.json().data.approvalId;

  const queue = await app.inject({
    method: "GET",
    url: "/api/internal/v1/approvals?pendingMyDecision=true",
    headers: headers("ceo"),
  });
  assert.equal(queue.statusCode, 200);
  const ids = queue.json().data.approvals.map((a: { id: string }) => a.id);
  assert.ok(ids.includes(approvalId), "CEO queue should include the new approval");

  const decided = await app.inject({
    method: "POST",
    url: `/api/internal/v1/approvals/${approvalId}/decide`,
    headers: headers("ceo", { "idempotency-key": randomUUID() }),
    payload: { decision: "approved", reason: "Solid case." },
  });
  assert.equal(decided.statusCode, 200);
  assert.equal(decided.json().data.decision, "approved");

  const after = getSnapshot().approvals.find((a) => a.id === approvalId);
  assert.equal(after?.status, "approved");
  assert.equal(after?.resolutionSummary, "Solid case.");
  await app.close();
});
