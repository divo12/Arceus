import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z, ZodError, type ZodSchema } from "zod";
import { getSnapshot } from "../../persistence/store.js";
import {
  setTaskStatus,
  setTaskVerified,
  appendTaskResult,
  appendTaskCommand,
  appendTaskPlanStep,
  setTaskPreviewUrl,
  attachArtifactToTask,
  hydrateTaskFromSpec,
} from "../../tasks/index.js";
import { updateTask, updateTaskProgress, upsertTask } from "../../persistence/store.js";
import type { Task } from "@arceus/contracts";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const TASK_BASE = "/api/internal/v1/tasks";

const zodDetails = (err: ZodError) =>
  err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const sendValidation = (reply: FastifyReply, err: ZodError): void => {
  reply.code(422).send({
    ...failure("Request validation failed.", "validation", "never", "payload_fixed"),
    error: {
      cause: "validation" as ErrorCause,
      retry: "never" as const,
      stopWhen: "payload_fixed",
      details: zodDetails(err),
    },
  });
};

const sendNotFound = (reply: FastifyReply, resource: string): void => {
  reply.code(404).send(failure(`${resource} not found.`, "not_found", "never", "resource_created"));
};

const sendConflict = (reply: FastifyReply, summary: string): void => {
  reply.code(409).send(failure(summary, "conflict", "never", "state_reset"));
};

const parseOrFail = <T>(schema: ZodSchema<T>, body: unknown, reply: FastifyReply): T | null => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidation(reply, parsed.error);
    return null;
  }
  return parsed.data;
};

const findTask = (taskId: string): Task | null =>
  getSnapshot().tasks.find((t) => t.id === taskId) ?? null;

const cacheAndSend = (
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: unknown,
  locationHeader?: string | null
): void => {
  if (locationHeader) void reply.header("location", locationHeader);
  cacheSuccessfulResponse(req, { status, body, locationHeader: locationHeader ?? null });
  reply.code(status).send(body);
};

// ── Schemas ──────────────────────────────────────────────

const createTaskBody = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  problemStatement: z.string().max(4000).optional(),
  deliverable: z.string().max(2000).optional(),
  definitionOfDone: z.array(z.string()).optional(),
  kind: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  assignedRole: z.string().optional(),
  sprintId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  dependsOnTaskIds: z.array(z.string()).optional(),
});

const patchTaskBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  assignedRole: z.string().optional(),
  assignedAgentId: z.string().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field required." });

const blockBody = z.object({
  reason: z.string().min(1).max(1000),
});

const verifyBody = z.object({
  verifiedBy: z.string().min(1),
});

const appendResultBody = z.object({
  entry: z.string().min(1).max(4000),
});

const appendCommandBody = z.object({
  command: z.string().min(1).max(2000),
  exitCode: z.number().int().optional(),
});

const claimBody = z.object({
  reason: z.string().min(1).max(1000),
});

const appendPlanStepBody = z.object({
  step: z.string().min(1).max(1000),
});

const progressBody = z.object({
  percent: z.number().min(0).max(100).optional(),
  note: z.string().max(2000).optional(),
  completedSteps: z.number().int().nonnegative().optional(),
  totalSteps: z.number().int().positive().nullable().optional(),
  filesModified: z.array(z.string()).optional(),
});

const previewUrlBody = z.object({
  url: z.string().url().nullable(),
});

const attachArtifactBody = z.object({
  artifactId: z.string().min(1),
});

const hydrateBody = z.object({
  title: z.string().min(1),
  description: z.string(),
  problem_statement: z.string(),
  deliverable: z.string(),
  definition_of_done: z.array(z.string()),
  priority: z.enum(["low", "medium", "high", "critical"]),
});

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpTasksRoutes(app: FastifyInstance): Promise<void> {
  // POST /tasks — create
  app.post(`${TASK_BASE}`, async (req, reply) => {
    const body = parseOrFail(createTaskBody, req.body, reply);
    if (!body) return;

    const mcp = req.mcp!;
    const taskId = body.id ?? `tsk_${randomUUID().slice(0, 12)}`;

    if (findTask(taskId)) {
      sendConflict(reply, `Task ${taskId} already exists.`);
      return;
    }

    const now = new Date().toISOString();
    const problemStatement = body.problemStatement ?? "";
    const task: Task = {
      id: taskId,
      companyId: mcp.companyId,
      sprintId: body.sprintId ?? null,
      kind: (body.kind ?? "implementation") as Task["kind"],
      title: body.title,
      description: body.description ?? "",
      problemStatement,
      deliverable: body.deliverable ?? "",
      definitionOfDone: body.definitionOfDone ?? [],
      status: "created",
      priority: body.priority ?? "medium",
      assignedRole: (body.assignedRole ?? "developer") as Task["assignedRole"],
      assignedAgentId: null,
      parentTaskId: body.parentTaskId ?? null,
      dependsOnTaskIds: body.dependsOnTaskIds ?? [],
      childTaskIds: [],
      artifactIds: [],
      localPreviewUrl: null,
      plannerState: { objective: problemStatement, planSteps: [], selectedTools: [], currentStepIndex: 0 },
      executorState: { currentCommand: null, commandsExecuted: [], results: [] },
      verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
      costCents: 0,
      iterationCount: 0,
      maxIterations: 3,
      incomingArtifactIds: [],
      createdAt: now,
    };

    upsertTask(task);
    const location = `${TASK_BASE}/${taskId}`;
    cacheAndSend(
      req,
      reply,
      201,
      success(`Task ${taskId} created.`, { taskId, status: task.status }),
      location
    );
  });

  // PATCH /tasks/:taskId — partial update
  app.patch<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId`, async (req, reply) => {
    const body = parseOrFail(patchTaskBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;

    if (!findTask(taskId)) {
      sendNotFound(reply, `Task ${taskId}`);
      return;
    }

    const updated = updateTask(taskId, (t) => ({
      ...t,
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.assignedRole !== undefined && { assignedRole: body.assignedRole as Task["assignedRole"] }),
      ...(body.assignedAgentId !== undefined && { assignedAgentId: body.assignedAgentId }),
    }));

    cacheAndSend(req, reply, 200, success(`Task ${taskId} updated.`, { taskId, updated: Boolean(updated) }));
  });

  // POST /tasks/:taskId/completion
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/completion`, async (req, reply) => {
    const { taskId } = req.params;
    const existing = findTask(taskId);
    if (!existing) {
      sendNotFound(reply, `Task ${taskId}`);
      return;
    }
    if (existing.status === "failed") {
      sendConflict(reply, `Task ${taskId} is already failed; cannot complete.`);
      return;
    }

    setTaskStatus(taskId, "completed");
    const unblocked = getSnapshot().tasks
      .filter((t) => t.dependsOnTaskIds.includes(taskId) && (t.status === "created" || t.status === "planned"))
      .map((t) => t.id);

    cacheAndSend(req, reply, 200, success(
      `Task ${taskId} marked completed.`,
      { taskId, status: "completed", unblockedDependents: unblocked },
      { nextActions: ["task_append_result", "artifact_create"] }
    ));
  });

  // POST /tasks/:taskId/block
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/block`, async (req, reply) => {
    const body = parseOrFail(blockBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    setTaskStatus(taskId, "blocked", body.reason);
    cacheAndSend(req, reply, 200, success(`Task ${taskId} blocked.`, { taskId, status: "blocked", reason: body.reason }));
  });

  // POST /tasks/:taskId/verification — tester-only
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/verification`, async (req, reply) => {
    if (req.mcp?.role !== "tester") {
      reply.code(403).send(failure("Verification requires tester role.", "governance", "never", "reassign_to_tester"));
      return;
    }
    const body = parseOrFail(verifyBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    setTaskVerified(taskId, body.verifiedBy);
    cacheAndSend(req, reply, 200, success(`Task ${taskId} verified.`, { taskId, verifiedBy: body.verifiedBy }));
  });

  // POST /tasks/:taskId/results
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/results`, async (req, reply) => {
    const body = parseOrFail(appendResultBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    appendTaskResult(taskId, body.entry);
    cacheAndSend(req, reply, 200, success(`Result appended to ${taskId}.`, { taskId }));
  });

  // POST /tasks/:taskId/commands
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/commands`, async (req, reply) => {
    const body = parseOrFail(appendCommandBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    appendTaskCommand(taskId, body.command);
    cacheAndSend(req, reply, 200, success(`Command appended to ${taskId}.`, { taskId }));
  });

  // POST /tasks/:taskId/plan-steps
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/plan-steps`, async (req, reply) => {
    const body = parseOrFail(appendPlanStepBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    appendTaskPlanStep(taskId, body.step);
    cacheAndSend(req, reply, 200, success(`Plan step appended to ${taskId}.`, { taskId }));
  });

  // PATCH /tasks/:taskId/progress
  app.patch<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/progress`, async (req, reply) => {
    const body = parseOrFail(progressBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    const mcp = req.mcp!;
    updateTaskProgress(taskId, {
      taskId,
      totalSteps: body.totalSteps ?? null,
      completedSteps: body.completedSteps ?? 0,
      currentStepDescription: body.note ?? "",
      lastBeatId: mcp.beatId,
      filesModified: body.filesModified ?? [],
      notes: body.note ?? "",
    });

    cacheAndSend(req, reply, 200, success(`Progress updated for ${taskId}.`, { taskId, percent: body.percent ?? null }));
  });

  // PUT /tasks/:taskId/preview-url
  app.put<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/preview-url`, async (req, reply) => {
    const body = parseOrFail(previewUrlBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    setTaskPreviewUrl(taskId, body.url);
    const status = 204;
    cacheSuccessfulResponse(req, { status, body: "", locationHeader: null });
    reply.code(status).send();
  });

  // POST /tasks/:taskId/artifacts — link existing artifact
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/artifacts`, async (req, reply) => {
    const body = parseOrFail(attachArtifactBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    attachArtifactToTask(taskId, body.artifactId);
    cacheAndSend(req, reply, 200, success(`Artifact ${body.artifactId} linked to ${taskId}.`, { taskId, artifactId: body.artifactId }));
  });

  // POST /tasks/:taskId/hydration — rehydrate from spec
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/hydration`, async (req, reply) => {
    const body = parseOrFail(hydrateBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!findTask(taskId)) { sendNotFound(reply, `Task ${taskId}`); return; }

    hydrateTaskFromSpec(taskId, body);
    cacheAndSend(req, reply, 200, success(`Task ${taskId} hydrated from spec.`, { taskId }));
  });

  // POST /tasks/:taskId/claim — agent claims a task (vision Step 7)
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/claim`, async (req, reply) => {
    const body = parseOrFail(claimBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    const existing = findTask(taskId);
    if (!existing) { sendNotFound(reply, `Task ${taskId}`); return; }

    const mcp = req.mcp!;

    // Only planned or created tasks can be claimed
    if (existing.status !== "planned" && existing.status !== "created") {
      sendConflict(reply, `Task ${taskId} is "${existing.status}" — only planned/created tasks can be claimed.`);
      return;
    }

    // Role check: agent can only claim tasks assigned to their role
    if (mcp.role && existing.assignedRole !== mcp.role) {
      reply.code(403).send(failure(
        `Task ${taskId} is assigned to ${existing.assignedRole}, not ${mcp.role}.`,
        "governance", "never", "claim_own_role_task"
      ));
      return;
    }

    setTaskStatus(taskId, "in_progress");
    cacheAndSend(req, reply, 200, success(
      `Task ${taskId} claimed by ${mcp.role ?? "agent"}.`,
      { taskId, status: "in_progress", claimedBy: mcp.role, reason: body.reason },
      { nextActions: ["task_append_plan_step", "task_update_progress"] }
    ));
  });
}
