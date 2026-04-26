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
import type { Task, RoleType } from "@arceus/contracts";
import { observability } from "@arceus/contracts";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";
import { readTaskHybrid, persistTask, CLAIM_FAILURES } from "./task-persistence.js";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";

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

/**
 * Phase 3C — DB-first read with store fallback. The fallback is temporary
 * until Phase 4 migrates remaining writers off the in-memory snapshot.
 */
const findTask = (taskId: string): Promise<Task | null> => readTaskHybrid(taskId);

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
  referenceArtifactIds: z.array(z.string()).max(10).optional(),
});

const patchTaskBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  assignedRole: z.string().optional(),
  assignedAgentId: z.string().nullable().optional(),
  referenceArtifactIds: z.array(z.string()).max(10).optional(),
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

    if (await findTask(taskId)) {
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
    observability.logEvent({
      event: "task.created",
      taskId,
      companyId: req.mcp!.companyId,
      sprintId: task.sprintId ?? null,
      assignedRole: (task.assignedRole ?? req.mcp!.role) as RoleType,
      ts: Date.now(),
    });

    // Attach reference artifacts if provided
    if (body.referenceArtifactIds?.length) {
      for (const artId of body.referenceArtifactIds) {
        attachArtifactToTask(taskId, artId);
        observability.logEvent({
          event: "task.artifact_attached",
          taskId,
          artifactId: artId,
          companyId: req.mcp!.companyId,
          ts: Date.now(),
        });
      }
    }

    await persistTask(taskId);

    const location = `${TASK_BASE}/${taskId}`;
    cacheAndSend(
      req,
      reply,
      201,
      success(`Task ${taskId} created.`, {
        taskId,
        status: task.status,
        attachedArtifactCount: body.referenceArtifactIds?.length ?? 0,
      }),
      location
    );
  });

  // PATCH /tasks/:taskId — partial update
  app.patch<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId`, async (req, reply) => {
    const body = parseOrFail(patchTaskBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;

    if (!(await findTask(taskId))) {
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
      ...(body.referenceArtifactIds !== undefined && { artifactIds: body.referenceArtifactIds }),
    }));

    if (updated) {
      const patchedFields = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
      observability.logEvent({
        event: "task.updated",
        taskId,
        companyId: req.mcp!.companyId,
        patch: patchedFields,
        ts: Date.now(),
      });
    }

    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(`Task ${taskId} updated.`, { taskId, updated: Boolean(updated) }));
  });

  // POST /tasks/:taskId/completion
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/completion`, async (req, reply) => {
    const { taskId } = req.params;
    const existing = await findTask(taskId);
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

    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(
      `Task ${taskId} marked completed.`,
      { taskId, status: "completed", unblockedDependents: unblocked },
      { nextActions: ["arceus_task_append_result", "arceus_artifact_create"] }
    ));
  });

  // POST /tasks/:taskId/block
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/block`, async (req, reply) => {
    const body = parseOrFail(blockBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

    setTaskStatus(taskId, "blocked", body.reason);
    await persistTask(taskId);
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
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

    setTaskVerified(taskId, body.verifiedBy);
    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(`Task ${taskId} verified.`, { taskId, verifiedBy: body.verifiedBy }));
  });

  // POST /tasks/:taskId/results
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/results`, async (req, reply) => {
    const body = parseOrFail(appendResultBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

    appendTaskResult(taskId, body.entry);
    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(`Result appended to ${taskId}.`, { taskId }));
  });

  // POST /tasks/:taskId/commands
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/commands`, async (req, reply) => {
    const body = parseOrFail(appendCommandBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

    appendTaskCommand(taskId, body.command);
    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(`Command appended to ${taskId}.`, { taskId }));
  });

  // POST /tasks/:taskId/plan-steps
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/plan-steps`, async (req, reply) => {
    const body = parseOrFail(appendPlanStepBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

    appendTaskPlanStep(taskId, body.step);
    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(`Plan step appended to ${taskId}.`, { taskId }));
  });

  // PATCH /tasks/:taskId/progress
  app.patch<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/progress`, async (req, reply) => {
    const body = parseOrFail(progressBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

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

    // Progress map lives outside the task row (separate concern); no DB sync needed.
    cacheAndSend(req, reply, 200, success(`Progress updated for ${taskId}.`, { taskId, percent: body.percent ?? null }));
  });

  // PUT /tasks/:taskId/preview-url
  app.put<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/preview-url`, async (req, reply) => {
    const body = parseOrFail(previewUrlBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

    setTaskPreviewUrl(taskId, body.url);
    await persistTask(taskId);
    const status = 204;
    cacheSuccessfulResponse(req, { status, body: "", locationHeader: null });
    reply.code(status).send();
  });

  // POST /tasks/:taskId/artifacts — RETIRED (Spec 28 Phase C.1).
  // Use `task_create({ referenceArtifactIds })` or `task_update({ referenceArtifactIds })`.
  // Returns 410 Gone for ~2 weeks, then removed.
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/artifacts`, async (_req, reply) => {
    reply.code(410).send({
      ...failure(
        "task_attach_artifact is retired. Use task_create({referenceArtifactIds}) or task_update({referenceArtifactIds}).",
        "tool_retired",
        "never",
        "caller_updated",
      ),
      replacement: "task_update",
    });
  });

  // POST /tasks/:taskId/hydration — rehydrate from spec
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/hydration`, async (req, reply) => {
    const body = parseOrFail(hydrateBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    if (!(await findTask(taskId))) { sendNotFound(reply, `Task ${taskId}`); return; }

    hydrateTaskFromSpec(taskId, body);
    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(`Task ${taskId} hydrated from spec.`, { taskId }));
  });

  // POST /tasks/:taskId/claim — agent claims a task (Phase 3C: race-safe CAS)
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/claim`, async (req, reply) => {
    const body = parseOrFail(claimBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    const existing = await findTask(taskId);
    if (!existing) { sendNotFound(reply, `Task ${taskId}`); return; }

    const mcp = req.mcp!;

    // Role gate (governance) — repo CAS doesn't know about MCP roles, so we
    // enforce here before paying the DB roundtrip.
    if (mcp.role && existing.assignedRole !== mcp.role) {
      const spec = CLAIM_FAILURES.wrong_role;
      reply.code(spec.status).send(failure(spec.summaryFor(taskId), spec.cause, spec.retry, spec.stopWhen));
      return;
    }

    // Dependency check — all `dependsOnTaskIds` must be completed/verified.
    if (existing.dependsOnTaskIds.length > 0) {
      const snapshot = getSnapshot();
      const missing = existing.dependsOnTaskIds.filter((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return !dep || !["completed", "verified"].includes(dep.status);
      });
      if (missing.length > 0) {
        reply.code(409).send({
          ...failure(
            `Cannot claim ${taskId}: ${missing.length} dependency task(s) not yet completed.`,
            "deps_unmet", "never", "deps_completed"
          ),
          error: {
            cause: "deps_unmet" as ErrorCause,
            retry: "never" as const,
            stopWhen: "deps_completed",
            details: { missing },
          },
        });
        return;
      }
    }

    // NOTE: persistTask does a full UPSERT of store state including
    // `status`. We don't call it AFTER a successful CAS — that would race
    // and let a late persistTask from one request overwrite the
    // in_progress status a concurrent winner just set, effectively
    // undoing the claim.
    //
    // Tasks SHOULD already be in the DB by the time we reach this handler
    // (store.upsertTask now fires persistTask fire-and-forget; sprint
    // creation barriers on a per-task await). If a fast-poll beat lands
    // before the dual-write resolves we backfill once below.
    let result = await tasksRepo.claimTask(getDb(), taskId, mcp.beatId);
    if (!result.ok && result.cause === "not_found") {
      // Backfill the DB row from the snapshot and retry the CAS once.
      // Reading snapshot status (planned/created/ready) and upserting BEFORE
      // the retry is safe: the CAS atomically flips to in_progress, so we
      // can't clobber a concurrent winner's claim.
      console.log(`[claim] not_found backfill+retry id=${taskId} beat=${mcp.beatId}`);
      await persistTask(taskId);
      result = await tasksRepo.claimTask(getDb(), taskId, mcp.beatId);
      console.log(`[claim] retry result=${result.ok ? "ok" : result.cause} id=${taskId}`);
    }
    if (!result.ok) {
      const spec = CLAIM_FAILURES[result.cause];
      reply.code(spec.status).send(failure(spec.summaryFor(taskId), spec.cause, spec.retry, spec.stopWhen));
      return;
    }

    // Mirror to store so the 14 non-route consumers see the new status.
    setTaskStatus(taskId, "in_progress");

    cacheAndSend(req, reply, 200, success(
      `Task ${taskId} claimed by ${mcp.role ?? "agent"}.`,
      { taskId, status: "in_progress", claimedBy: mcp.role, reason: body.reason },
      { nextActions: ["arceus_task_append_plan_step", "arceus_task_update_progress"] }
    ));
  });

  // GET /tasks/:taskId — read a task (optionally with progress)
  app.get<{ Params: { taskId: string }; Querystring: { includeProgress?: string } }>(
    `${TASK_BASE}/:taskId`,
    async (req, reply) => {
      const { taskId } = req.params;
      const task = await findTask(taskId);
      if (!task) { sendNotFound(reply, `Task ${taskId}`); return; }

      const includeProgress = req.query.includeProgress === "true";
      if (!includeProgress) {
        cacheAndSend(req, reply, 200, success(`Task ${taskId}.`, { task }));
        return;
      }

      // Build progress data from task's planner/executor state
      const planSteps = task.plannerState?.planSteps?.map((s, i) => ({
        ts: task.createdAt,
        step: typeof s === "string" ? s : String(s),
        index: i,
      })) ?? [];

      const commands = task.executorState?.commandsExecuted?.map((c) => ({
        ts: task.createdAt,
        cmd: typeof c === "string" ? c : String(c),
      })) ?? [];

      const snapshot = getSnapshot();
      const totalSteps = planSteps.length || 1;
      const completedSteps = commands.length;
      const percentComplete = Math.min(Math.round((completedSteps / totalSteps) * 100), 100);

      cacheAndSend(req, reply, 200, success(`Task ${taskId} with progress.`, {
        task,
        progress: {
          planSteps,
          commands,
          percentComplete,
          lastAppendedAt: task.executorState?.commandsExecuted?.length ? new Date().toISOString() : null,
        },
      }));
    },
  );

  // POST /tasks/:taskId/report-bug — any role can report a bug found during work
  app.post<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/report-bug`, async (req, reply) => {    const reportBugBody = z.object({
      bugTitle: z.string().min(1).max(200),
      bugDescription: z.string().min(1).max(4000),
      severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
      reproducible: z.boolean().default(true),
      stepsToReproduce: z.string().max(4000).optional(),
    });
    const body = parseOrFail(reportBugBody, req.body, reply);
    if (!body) return;
    const { taskId } = req.params;
    const sourceTask = await findTask(taskId);
    if (!sourceTask) { sendNotFound(reply, `Task ${taskId}`); return; }

    const mcp = req.mcp!;
    const bugId = `tsk_bug_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    const bugTask: Task = {
      id: bugId,
      companyId: mcp.companyId,
      sprintId: sourceTask.sprintId,
      kind: "bug_fix",
      title: body.bugTitle,
      description: body.bugDescription + (body.stepsToReproduce
        ? `\n\n**Steps to reproduce:**\n${body.stepsToReproduce}`
        : ""),
      problemStatement: `Bug found during task ${taskId}: ${body.bugTitle}`,
      deliverable: `Fix: ${body.bugTitle}`,
      definitionOfDone: ["Bug no longer reproducible", "Regression test added"],
      status: "created",
      priority: body.severity ?? "medium",
      assignedRole: "developer",
      assignedAgentId: null,
      parentTaskId: taskId,
      dependsOnTaskIds: [],
      childTaskIds: [],
      artifactIds: [],
      localPreviewUrl: null,
      plannerState: { objective: body.bugDescription, planSteps: [], selectedTools: [], currentStepIndex: 0 },
      executorState: { currentCommand: null, commandsExecuted: [], results: [] },
      verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
      costCents: 0,
      iterationCount: 0,
      maxIterations: 3,
      incomingArtifactIds: [],
      createdAt: now,
    };

    upsertTask(bugTask);
    await persistTask(bugId);

    cacheAndSend(
      req,
      reply,
      201,
      success(`Bug ${bugId} reported from task ${taskId}.`, {
        bugTaskId: bugId,
        sourceTaskId: taskId,
        severity: body.severity,
        status: "created",
      }),
      `${TASK_BASE}/${bugId}`,
    );
  });

  // GET /tasks/:taskId/preview-path — return preview slot info for a task
  app.get<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/preview-path`, async (req, reply) => {
    const { taskId } = req.params;
    const task = await findTask(taskId);
    if (!task) { sendNotFound(reply, `Task ${taskId}`); return; }

    cacheAndSend(req, reply, 200, success(`Preview info for ${taskId}.`, {
      taskId,
      previewUrl: task.localPreviewUrl,
      previewPath: null,
      lastProbedAt: null,
    }));
  });

  // GET /tasks/:taskId/progress — list plan steps + commands without full task body
  app.get<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/progress`, async (req, reply) => {
    const { taskId } = req.params;
    const task = await findTask(taskId);
    if (!task) { sendNotFound(reply, `Task ${taskId}`); return; }

    const planSteps = task.plannerState?.planSteps?.map((s, i) => ({
      ts: task.createdAt,
      step: typeof s === "string" ? s : String(s),
      index: i,
    })) ?? [];

    const commands = task.executorState?.commandsExecuted?.map((c) => ({
      ts: task.createdAt,
      cmd: typeof c === "string" ? c : String(c),
    })) ?? [];

    const totalSteps = planSteps.length || 1;
    const completedSteps = commands.length;
    const percentComplete = Math.min(Math.round((completedSteps / totalSteps) * 100), 100);

    cacheAndSend(req, reply, 200, success(`Progress for ${taskId}.`, {
      taskId,
      planSteps,
      commands,
      percentComplete,
    }));
  });

  // DELETE /tasks/:taskId/progress — clear plan-step + command history. CTO/PM only.
  app.delete<{ Params: { taskId: string } }>(`${TASK_BASE}/:taskId/progress`, async (req, reply) => {
    const role = req.mcp?.role;
    if (role !== "cto" && role !== "pm") {
      reply.code(403).send(failure(
        "Clearing task progress requires cto or pm role.",
        "governance", "never", "reassign_to_cto_or_pm",
      ));
      return;
    }
    const { taskId } = req.params;
    const existing = await findTask(taskId);
    if (!existing) { sendNotFound(reply, `Task ${taskId}`); return; }

    const cleared = updateTask(taskId, (t) => ({
      ...t,
      plannerState: { ...t.plannerState, planSteps: [], currentStepIndex: 0 },
      executorState: { ...t.executorState, commandsExecuted: [], results: [] },
    }));

    await persistTask(taskId);
    cacheAndSend(req, reply, 200, success(`Progress cleared for ${taskId}.`, {
      taskId,
      cleared: Boolean(cleared),
    }));
  });
}
