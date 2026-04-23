import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";
import { bootstrapCompany } from "../../persistence/store.js";

const TEST_TOKEN = "arceus-test-token-for-integration";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const baseHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": "beat_test",
  "x-company-id": "c_test",
  "x-agent-role": "developer",
  "content-type": "application/json",
  ...extra,
});

// ─── Artifacts ────────────────────────────────────────────

test("POST /artifacts creates artifact with 201 + Location", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "Art Co", industry: "tech", goals: "t", founderVision: "v" } as any);
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/artifacts",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: { agent: "developer", kind: "code", title: "snippet", content: "console.log('hi');" },
  });
  assert.equal(res.statusCode, 201);
  assert.match(res.headers.location as string, /\/api\/internal\/v1\/artifacts\/artifact_/);
  const body = res.json();
  assert.equal(body.status, "success");
  assert.ok(body.data.artifactId.startsWith("artifact_"));
  await app.close();
});

test("POST /artifacts with invalid kind returns 422", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/artifacts",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: { agent: "developer", kind: "banana", title: "x", content: "y" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error.cause, "validation");
  await app.close();
});

test("POST /artifacts/:id/persistence on missing artifact returns 404", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/artifacts/artifact_missing/persistence",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error.cause, "not_found");
  await app.close();
});

// ─── Workspaces ───────────────────────────────────────────

test("POST /workspaces/preview-probes returns probe result", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/workspaces/preview-probes",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "success");
  assert.equal(typeof body.data.reachable, "boolean");
  await app.close();
});

test("POST /workspaces/preview-probes with invalid timeout returns 422", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/workspaces/preview-probes",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: { timeoutMs: 99 },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error.cause, "validation");
  await app.close();
});

// ─── Tasks ─────────────────────────────────────────────────

test("POST /tasks without bearer returns 401 envelope", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: { "content-type": "application/json" },
    payload: { title: "x" },
  });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.status, "error");
  assert.equal(body.error.cause, "governance");
  await app.close();
});

test("POST /tasks without Idempotency-Key succeeds (no idempotency protection)", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "Test Co", industry: "tech", goals: "test", founderVision: "v" } as any);
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: baseHeaders(),
    payload: { title: "x" },
  });
  // Without an idempotency key the request goes through but has no replay protection
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.status, "success");
  await app.close();
});

test("POST /tasks creates a task with 201 + Location", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "Test Co", industry: "tech", goals: "test", founderVision: "v" } as any);
  const app = await buildApp();
  const idKey = randomUUID();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: baseHeaders({ "idempotency-key": idKey }),
    payload: { id: "tsk_a1", title: "Test task" },
  });

  assert.equal(res.statusCode, 201);
  assert.match(res.headers.location as string, /\/api\/internal\/v1\/tasks\/tsk_a1/);
  const body = res.json();
  assert.equal(body.status, "success");
  assert.equal(body.data.taskId, "tsk_a1");
  await app.close();
});

test("idempotency replay returns cached 201 on same key+body", async () => {
  resetIdempotency();
  const app = await buildApp();
  const idKey = randomUUID();
  const first = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: baseHeaders({ "idempotency-key": idKey }),
    payload: { id: "tsk_replay", title: "First" },
  });
  assert.equal(first.statusCode, 201);

  const second = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: baseHeaders({ "idempotency-key": idKey }),
    payload: { id: "tsk_replay", title: "First" },
  });
  assert.equal(second.statusCode, 201);
  await app.close();
});

test("idempotency conflict returns 409 on same key + different body", async () => {
  resetIdempotency();
  const app = await buildApp();
  const idKey = randomUUID();
  await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: baseHeaders({ "idempotency-key": idKey }),
    payload: { id: "tsk_c1", title: "One" },
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: baseHeaders({ "idempotency-key": idKey }),
    payload: { id: "tsk_c1", title: "Two" },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error.cause, "conflict");
  await app.close();
});

test("POST completion on missing task returns 404 envelope", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks/tsk_missing/completion",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error.cause, "not_found");
  await app.close();
});

// ─── Meetings ─────────────────────────────────────────────

test("POST /meetings records a meeting with 201 + Location", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/meetings",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {
      type: "daily_sync",
      facilitatorRole: "ceo",
      participantRoles: ["ceo", "cto"],
      summary: "Morning sync",
      agenda: [
        {
          topic: "Sprint kickoff",
          type: "update",
          content: "Starting sprint 1",
          raisedByRole: "ceo",
        },
      ],
    },
  });
  assert.equal(res.statusCode, 201);
  assert.match(res.headers.location as string, /\/api\/internal\/v1\/meetings\/meeting_/);
  const body = res.json();
  assert.equal(body.status, "success");
  assert.ok(body.data.meetingId.startsWith("meeting_"));
  await app.close();
});

test("POST /meetings with invalid type returns 422", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/meetings",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {
      type: "invalid_type",
      facilitatorRole: "ceo",
      participantRoles: ["ceo"],
      summary: "x",
      agenda: [{ topic: "x", type: "update", content: "x", raisedByRole: "ceo" }],
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error.cause, "validation");
  await app.close();
});

// ─── Approvals ────────────────────────────────────────────

test("POST /approvals with unknown type returns 422", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {
      type: "unknown_type",
      requestedByRole: "marketing",
      title: "x",
      description: "y",
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error.cause, "validation");
  await app.close();
});

test("POST /approvals with missing required fields returns 422", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: { type: "external_action", requestedByRole: "marketing" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error.cause, "validation");
  await app.close();
});

test("POST /approvals returns 409 when requesting role is not provisioned", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "App Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/approvals",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {
      type: "external_action",
      requestedByRole: "marketing",
      title: "Board approval for launch campaign",
      description: "Outbound distribution requires board sign-off before execution.",
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error.cause, "conflict");
  await app.close();
});

// ─── Sprints ──────────────────────────────────────────────

test("POST /sprints/proposals requires ceo role (403)", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/proposals",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.cause, "governance");
  await app.close();
});

test("POST /sprints/proposals as ceo returns 202", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/proposals",
    headers: baseHeaders({ "idempotency-key": randomUUID(), "x-agent-role": "ceo" }),
    payload: {},
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.status, "success");
  assert.equal(body.data.queued, true);
  await app.close();
});

test("POST verification requires tester role (403)", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks/tsk_v1/verification",
    headers: baseHeaders({ "idempotency-key": randomUUID() }),
    payload: { verifiedBy: "agent_q" },
  });
  assert.equal(res.statusCode, 403);
  const body = res.json();
  assert.equal(body.error.cause, "governance");
  await app.close();
});
