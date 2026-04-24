// Spec 28 Phase D — task_get / task_report_bug / task_get_preview_path /
// task_list_progress / task_clear_progress / task_append_command route coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";
import { bootstrapCompany } from "../../persistence/store.js";
import { setTaskPreviewUrl, appendTaskCommand, appendTaskPlanStep } from "../../tasks/index.js";

const TEST_TOKEN = "arceus-test-token-phase-d";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const headers = (role = "developer", extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": "beat_phase_d",
  "x-company-id": "c_phase_d",
  "x-agent-role": role,
  "content-type": "application/json",
  ...extra,
});

const seedTask = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  id: string,
  overrides: Record<string, unknown> = {}
) => {
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks",
    headers: headers("pm", { "idempotency-key": randomUUID() }),
    payload: { id, title: `Task ${id}`, assignedRole: "developer", ...overrides },
  });
  assert.equal(res.statusCode, 201, `seed task ${id} failed: ${res.body}`);
};

// ─── task_get ─────────────────────────────────────────────

test("GET /tasks/:id returns the task", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_get1");

  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_get1",
    headers: headers(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "success");
  assert.equal(body.data.task.id, "tsk_pd_get1");
  assert.equal(body.data.progress, undefined);
  await app.close();
});

test("GET /tasks/:id?includeProgress=true returns progress block", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_prog");
  appendTaskPlanStep("tsk_pd_prog", "draft");
  appendTaskCommand("tsk_pd_prog", "pnpm install");

  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_prog?includeProgress=true",
    headers: headers(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.progress.planSteps.length, 1);
  assert.equal(body.data.progress.commands.length, 1);
  assert.equal(typeof body.data.progress.percentComplete, "number");
  await app.close();
});

test("GET /tasks/:id 404 envelope on missing", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_missing",
    headers: headers(),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.cause, "not_found");
  await app.close();
});

// ─── task_report_bug ──────────────────────────────────────

test("POST /tasks/:id/report-bug creates a child bug task", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_src");

  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks/tsk_pd_src/report-bug",
    headers: headers("tester", { "idempotency-key": randomUUID() }),
    payload: {
      bugTitle: "Login button broken",
      bugDescription: "Clicking the login button does nothing.",
      severity: "high",
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.data.bugTaskId.startsWith("tsk_bug_"));
  assert.equal(body.data.sourceTaskId, "tsk_pd_src");
  assert.equal(body.data.severity, "high");
  await app.close();
});

// ─── task_get_preview_path ────────────────────────────────

test("GET /tasks/:id/preview-path returns previewUrl from task", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_prev");
  setTaskPreviewUrl("tsk_pd_prev", "http://localhost:5173");

  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_prev/preview-path",
    headers: headers(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.previewUrl, "http://localhost:5173");
  assert.equal(body.data.previewPath, null);
  assert.equal(body.data.lastProbedAt, null);
  await app.close();
});

test("GET /tasks/:id/preview-path 404 on missing", async () => {
  resetIdempotency();
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_nope/preview-path",
    headers: headers(),
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ─── task_list_progress ───────────────────────────────────

test("GET /tasks/:id/progress returns plan steps and commands", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_lp");
  appendTaskPlanStep("tsk_pd_lp", "step one");
  appendTaskPlanStep("tsk_pd_lp", "step two");
  appendTaskCommand("tsk_pd_lp", "echo hi");

  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_lp/progress",
    headers: headers(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.taskId, "tsk_pd_lp");
  assert.equal(body.data.planSteps.length, 2);
  assert.equal(body.data.commands.length, 1);
  assert.equal(body.data.percentComplete, 50);
  await app.close();
});

// ─── task_clear_progress ──────────────────────────────────

test("DELETE /tasks/:id/progress as developer is forbidden", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_cp1");

  const res = await app.inject({
    method: "DELETE",
    url: "/api/internal/v1/tasks/tsk_pd_cp1/progress",
    headers: headers("developer", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.cause, "governance");
  await app.close();
});

test("DELETE /tasks/:id/progress as cto clears arrays", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_cp2");
  appendTaskPlanStep("tsk_pd_cp2", "x");
  appendTaskCommand("tsk_pd_cp2", "y");

  const res = await app.inject({
    method: "DELETE",
    url: "/api/internal/v1/tasks/tsk_pd_cp2/progress",
    headers: headers("cto", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.cleared, true);

  const after = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_cp2/progress",
    headers: headers(),
  });
  const body = after.json();
  assert.equal(body.data.planSteps.length, 0);
  assert.equal(body.data.commands.length, 0);
  await app.close();
});

test("DELETE /tasks/:id/progress as pm is allowed", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_cp3");

  const res = await app.inject({
    method: "DELETE",
    url: "/api/internal/v1/tasks/tsk_pd_cp3/progress",
    headers: headers("pm", { "idempotency-key": randomUUID() }),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

// ─── task_append_command (existing route — guard against regression) ──

test("POST /tasks/:id/commands appends to executor log", async () => {
  resetIdempotency();
  bootstrapCompany({ companyName: "PD Co", industry: "tech", goals: "g", founderVision: "v" } as any);
  const app = await buildApp();
  await seedTask(app, "tsk_pd_cmd");

  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/tasks/tsk_pd_cmd/commands",
    headers: headers("developer", { "idempotency-key": randomUUID() }),
    payload: { command: "pnpm test", exitCode: 0 },
  });
  assert.equal(res.statusCode, 200);

  const after = await app.inject({
    method: "GET",
    url: "/api/internal/v1/tasks/tsk_pd_cmd/progress",
    headers: headers(),
  });
  assert.equal(after.json().data.commands.length, 1);
  await app.close();
});
