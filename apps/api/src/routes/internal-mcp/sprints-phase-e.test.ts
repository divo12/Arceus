// Spec 28 Phase E — sprint gates: check_completion, qa_gate, final_gate, finalize.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";
import { bootstrapCompany, upsertSprint, upsertTask, getSnapshot } from "../../persistence/store.js";
import type { Sprint, Task } from "@arceus/contracts";

const TEST_TOKEN = "arceus-test-token-phase-e";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const headers = (role: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": "beat_phase_e",
  "x-company-id": "c_phase_e",
  "x-agent-role": role,
  "content-type": "application/json",
  ...extra,
});

const seedSprint = (id: string): Sprint => {
  const now = new Date().toISOString();
  const sprint: Sprint = {
    id,
    companyId: "c_phase_e",
    strategyId: null,
    number: 1,
    title: `Sprint ${id}`,
    goal: "ship the thing",
    status: "executing",
    plannedByAgentId: null,
    summary: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
  };
  upsertSprint(sprint);
  return sprint;
};

const seedTask = (id: string, sprintId: string, overrides: Partial<Task> = {}): Task => {
  const now = new Date().toISOString();
  const task: Task = {
    id,
    companyId: "c_phase_e",
    sprintId,
    kind: "implementation",
    title: id,
    description: "",
    problemStatement: "",
    deliverable: "",
    definitionOfDone: [],
    status: "created",
    priority: "medium",
    assignedRole: "developer",
    assignedAgentId: null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
    executorState: { currentCommand: null, commandsExecuted: [], results: [] },
    verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    incomingArtifactIds: [],
    createdAt: now,
    ...overrides,
  };
  upsertTask(task);
  return task;
};

// ─── sprint_check_completion ──────────────────────────────

test("GET /sprints/:id/completion 404 when sprint missing", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/sprints/spr_missing/completion",
    headers: headers("ceo"),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.cause, "not_found");
  await app.close();
});

test("GET /sprints/:id/completion reports counts and readyToFinalize=false when work remains", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_1");
  seedTask("tsk_pe_a", "spr_pe_1", { status: "completed", verifierState: { isVerified: true, feedback: null, verifiedByAgentId: "qa" } });
  seedTask("tsk_pe_b", "spr_pe_1", { status: "in_progress" });
  seedTask("tsk_pe_c", "spr_pe_1", { status: "blocked" });

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/sprints/spr_pe_1/completion",
    headers: headers("ceo"),
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.total, 3);
  assert.equal(data.completed, 1);
  assert.equal(data.verified, 1);
  assert.equal(data.blocked, 1);
  assert.equal(data.remainingRequired, 2);
  assert.equal(data.readyToFinalize, false);
  await app.close();
});

test("GET /sprints/:id/completion readyToFinalize=true when all done and unblocked", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_2");
  seedTask("tsk_pe_d", "spr_pe_2", { status: "completed", verifierState: { isVerified: true, feedback: null, verifiedByAgentId: "qa" } });
  seedTask("tsk_pe_e", "spr_pe_2", { status: "completed", verifierState: { isVerified: true, feedback: null, verifiedByAgentId: "qa" } });

  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/sprints/spr_pe_2/completion",
    headers: headers("ceo"),
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.readyToFinalize, true);
  assert.equal(data.remainingRequired, 0);
  await app.close();
});

// ─── sprint_run_qa_gate ───────────────────────────────────

test("POST /sprints/:id/qa-gate as developer is forbidden", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_qa1");
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/spr_pe_qa1/qa-gate",
    headers: headers("developer", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("POST /sprints/:id/qa-gate as tester reports unverified + failed tasks", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_qa2");
  seedTask("tsk_pe_unv", "spr_pe_qa2", { status: "completed", verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null } });
  seedTask("tsk_pe_fail", "spr_pe_qa2", { status: "failed" });

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/spr_pe_qa2/qa-gate",
    headers: headers("tester", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.passed, false);
  assert.equal(data.unverifiedTasks.length, 1);
  assert.equal(data.failedTasks.length, 1);
  await app.close();
});

// ─── sprint_run_final_gate ────────────────────────────────

test("POST /sprints/:id/final-gate as tester is forbidden", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_fg1");
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/spr_pe_fg1/final-gate",
    headers: headers("tester", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("POST /sprints/:id/final-gate as cto returns task summary", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_fg2");
  seedTask("tsk_pe_fg_v", "spr_pe_fg2", { status: "completed", verifierState: { isVerified: true, feedback: null, verifiedByAgentId: "qa" } });

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/spr_pe_fg2/final-gate",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.allVerified, true);
  assert.equal(data.taskSummary.verified, 1);
  await app.close();
});

// ─── sprint_finalize + end-to-end exit criterion ──────────

test("POST /sprints/:id/finalize as developer is forbidden", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_fin1");
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/spr_pe_fin1/finalize",
    headers: headers("developer", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("end-to-end: CEO checks completion green, then finalizes sprint", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PE Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  seedSprint("spr_pe_e2e");
  seedTask("tsk_pe_e2e_a", "spr_pe_e2e", { status: "completed", verifierState: { isVerified: true, feedback: null, verifiedByAgentId: "qa" } });
  seedTask("tsk_pe_e2e_b", "spr_pe_e2e", { status: "completed", verifierState: { isVerified: true, feedback: null, verifiedByAgentId: "qa" } });

  const app = await buildApp();

  const check = await app.inject({
    method: "GET",
    url: "/api/internal/v1/sprints/spr_pe_e2e/completion",
    headers: headers("ceo"),
  });
  assert.equal(check.statusCode, 200);
  assert.equal(check.json().data.readyToFinalize, true);

  const fin = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/spr_pe_e2e/finalize",
    headers: headers("ceo", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(fin.statusCode, 200);
  const data = fin.json().data;
  assert.equal(data.completedTasks, 2);
  assert.equal(data.totalTasks, 2);
  assert.ok(data.finalizedAt);

  // Sprint status updated in snapshot
  const sprint = getSnapshot().sprints.find((s) => s.id === "spr_pe_e2e");
  assert.equal(sprint?.status, "completed");

  // Second finalize → 409 conflict
  const dup = await app.inject({
    method: "POST",
    url: "/api/internal/v1/sprints/spr_pe_e2e/finalize",
    headers: headers("ceo", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(dup.statusCode, 409);
  await app.close();
});
