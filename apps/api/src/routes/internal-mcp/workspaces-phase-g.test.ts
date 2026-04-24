// Spec 28 Phase G — workspace MCP read tools: preview-url, build-health, check-exports, verify-baseline.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import internalMcpRoutes from "./index.js";
import { __resetForTest as resetIdempotency } from "./idempotency.js";
import { __resetBearerToken } from "../../auth/bearer.js";
import { bootstrapCompany, upsertTask } from "../../persistence/store.js";
import {
  recordTypecheck,
  recordPreview,
  resetHealthForTests,
} from "../../workspace/build-health.js";
import { workspaceManager } from "../../workspace/manager.js";
import type { Task } from "@arceus/contracts";

const TEST_TOKEN = "arceus-test-token-phase-g";
process.env.ARCEUS_INTERNAL_TOKEN = TEST_TOKEN;
__resetBearerToken();

const buildApp = async () => {
  const app = Fastify();
  await app.register(internalMcpRoutes);
  return app;
};

const headers = (role = "developer") => ({
  authorization: `Bearer ${TEST_TOKEN}`,
  "x-beat-id": "beat_phase_g",
  "x-company-id": "c_phase_g",
  "x-agent-role": role,
  "content-type": "application/json",
});

const seedTask = (id: string, overrides: Partial<Task> = {}): Task => {
  const now = new Date().toISOString();
  const task: Task = {
    id,
    companyId: "c_phase_g",
    sprintId: null,
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

test("Phase G — preview-url 404 on unknown task", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/workspaces/preview-url?taskId=tsk_missing",
    headers: headers(),
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("Phase G — preview-url returns task.localPreviewUrl", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  seedTask("tsk_g_1", { localPreviewUrl: "http://localhost:5173" });
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/workspaces/preview-url?taskId=tsk_g_1",
    headers: headers(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: { previewUrl: string } };
  assert.equal(body.data.previewUrl, "http://localhost:5173");
  await app.close();
});

test("Phase G — preview-url with no taskId returns null", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/workspaces/preview-url",
    headers: headers(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: { previewUrl: string | null } };
  assert.equal(body.data.previewUrl, null);
  await app.close();
});

test("Phase G — build-health reflects recorded values", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  recordTypecheck(false, ["src/foo.ts(1,1): error TS2304: Cannot find name 'x'."]);
  recordPreview(true, []);
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/internal/v1/workspaces/build-health",
    headers: headers(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    data: {
      typecheck: { status: string; errorsFirstN: string[] };
      preview: { status: string };
      build: { status: string };
      test: { status: string };
    };
  };
  assert.equal(body.data.typecheck.status, "fail");
  assert.equal(body.data.typecheck.errorsFirstN.length, 1);
  assert.equal(body.data.preview.status, "ok");
  assert.equal(body.data.build.status, "unknown");
  await app.close();
});

test("Phase G — check-exports detects missing exports", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);

  const root = workspaceManager.getLegacyProductDir();
  const moduleDir = mkdtempSync(join(root, "phase-g-"));
  const modulePath = join(moduleDir, "mod.ts");
  writeFileSync(modulePath, [
    "export function alpha() { return 1; }",
    "export const beta = 2;",
    "export default function ds() {}",
  ].join("\n"));

  const relative = modulePath.slice(root.length + 1).replace(/\\/g, "/");
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/workspaces/check-exports",
    headers: headers(),
    payload: { modulePath: relative, expectedExports: ["alpha", "beta", "gamma"] },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: { found: string[]; missing: string[]; ok: boolean } };
  assert.deepEqual(body.data.missing, ["gamma"]);
  assert.equal(body.data.ok, false);
  assert.ok(body.data.found.includes("alpha"));
  assert.ok(body.data.found.includes("default"));
  await app.close();
});

test("Phase G — check-exports rejects path escape", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/workspaces/check-exports",
    headers: headers(),
    payload: { modulePath: "../../etc/passwd", expectedExports: ["x"] },
  });
  assert.equal(res.statusCode, 422);
  await app.close();
});

test("Phase G — check-exports 404 on missing module", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/workspaces/check-exports",
    headers: headers(),
    payload: { modulePath: "does/not/exist.ts", expectedExports: ["x"] },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("Phase G — verify-baseline returns shape with skipPreview", async () => {
  resetIdempotency();
  resetHealthForTests();
  bootstrapCompany({ companyName: "C", boardOwner: "ceo", idea: "i", budgetCents: 100 } as never);
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/v1/workspaces/verify-baseline",
    headers: headers(),
    payload: { skipPreview: true, timeoutMs: 5000 },
  });
  // Either 200 ok or 200 with failures — both acceptable; we only assert envelope shape.
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    data: { ok: boolean; failures: Array<{ category: string; errors: string[] }>; ranAt: string };
  };
  assert.equal(typeof body.data.ok, "boolean");
  assert.ok(Array.isArray(body.data.failures));
  assert.ok(body.data.ranAt.length > 0);
  await app.close();
});
