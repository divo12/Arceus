import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodTypeAny } from "zod";
import { createSprintWithTasks } from "../../sprints/proposals.js";
import { finalizeSprintCompletion } from "../../sprints/lifecycle.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { observability } from "@arceus/contracts";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const SPRINTS_BASE = "/api/internal/v1/sprints";

const zodDetails = (err: ZodError) =>
  err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const sendValidation = (reply: FastifyReply, err: ZodError): FastifyReply => {
  return reply.code(422).send({
    ...failure("Request validation failed.", "validation", "never", "payload_fixed"),
    error: {
      cause: "validation" as ErrorCause,
      retry: "never" as const,
      stopWhen: "payload_fixed",
      details: zodDetails(err),
    },
  });
};

const parseOrFail = <S extends ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.output<S> | null => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidation(reply, parsed.error);
    return null;
  }
  return parsed.data as z.output<S>;
};

const cacheAndSend = (
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: unknown,
): FastifyReply => {
  cacheSuccessfulResponse(req, { status, body, locationHeader: null });
  return reply.code(status).send(body);
};

// ── Schemas ──────────────────────────────────────────────

const sprintTaskSchema = z.object({
  title: z.string().min(1).max(500),
  assigned_role: z.string().min(1),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  depends_on: z.array(z.string()).default([]),
  description: z.string().max(2000).default(""),
});

const sprintCreateBody = z.object({
  goal: z.string().min(3).max(1000),
  tasks: z.array(sprintTaskSchema).min(1).max(30),
});

export type SprintCreateInput = z.infer<typeof sprintCreateBody>;

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpSprintsRoutes(app: FastifyInstance): Promise<void> {
  // POST /sprints/create — CEO creates a sprint with tasks (synchronous, agentic)
  app.post(`${SPRINTS_BASE}/create`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      return reply.code(403).send(
        failure(
          "Only the CEO role may create sprints.",
          "governance",
          "never",
          "role_is_ceo",
        ),
      );
      return;
    }

    const parsed = parseOrFail(sprintCreateBody, req.body ?? {}, reply);
    if (parsed === null) return;

    // Boundary validation per vision: every assigned_role must map to a
    // currently hired agent. The CEO LLM sometimes invents roles
    // (e.g. "pm", "qa") that aren't in the org chart, which silently
    // deadlocks the sprint because no agent ever beats with that role and
    // dependents stay blocked forever. Reject up front and let the CEO
    // re-reason with a payload_fixed validation failure.
    // Spec 31 Phase 7.B.5 — agents from canonical view.
    const snapshot = await buildSnapshotView(req.mcp.companyId);
    const hiredRoles = new Set(snapshot.agents.map((a) => a.role));
    const invalid = parsed.tasks
      .map((t, i) => ({ idx: i, role: t.assigned_role, title: t.title }))
      .filter((t) => !hiredRoles.has(t.role as never));
    if (invalid.length > 0) {
      const validList = hiredRoles.size > 0
        ? Array.from(hiredRoles).sort().join(", ")
        : "(none — call strategy_apply first to hire agents)";
      const detail = invalid.map((t) => `task[${t.idx}] "${t.title}" → "${t.role}"`).join("; ");
      return reply.code(422).send({
        ...failure(
          `Unknown assigned_role on ${invalid.length} task(s). Valid roles for this company: [${validList}]. Offending: ${detail}`,
          "validation",
          "never",
          "payload_fixed",
        ),
        error: {
          cause: "validation" as ErrorCause,
          retry: "never" as const,
          stopWhen: "payload_fixed",
          details: invalid.map((t) => ({
            field: `tasks.${t.idx}.assigned_role`,
            message: `"${t.role}" is not a hired role. Valid: [${validList}]`,
            code: "unknown_role",
          })),
        },
      });
      return;
    }

    try {
      const result = await createSprintWithTasks(parsed, req.mcp.companyId);
      const sprintId = (result as { sprintId?: string; id?: string }).sprintId
        ?? (result as { sprintId?: string; id?: string }).id
        ?? "unknown";
      observability.logEvent({
        event: "sprint.created",
        sprintId,
        companyId: req.mcp.companyId,
        goal: parsed.goal,
        ts: Date.now(),
      });
      return cacheAndSend(req, reply, 201, success("Sprint created.", result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sprint creation failed.";
      return reply.code(400).send(failure(msg, "validation", "never", "payload_fixed"));
    }
  });

  // GET /sprints/active — get the currently active sprint
  app.get(`${SPRINTS_BASE}/active`, async (req, reply) => {
    const snapshot = await buildSnapshotView(req.mcp!.companyId);
    const company = snapshot.company;
    const activeSprint = snapshot.sprints.find((s) => s.id === company.currentSprintId);

    if (!activeSprint) {
      return reply.code(404).send(failure("No active sprint.", "not_found", "never", "sprint_created"));
      return;
    }

    const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === activeSprint.id);
    const taskCounts = {
      total: sprintTasks.length,
      created: sprintTasks.filter((t) => t.status === "created").length,
      planned: sprintTasks.filter((t) => t.status === "planned").length,
      in_progress: sprintTasks.filter((t) => t.status === "in_progress").length,
      completed: sprintTasks.filter((t) => t.status === "completed" && !t.verifierState.isVerified).length,
      verified: sprintTasks.filter((t) => t.status === "completed" && t.verifierState.isVerified).length,
      blocked: sprintTasks.filter((t) => t.status === "blocked").length,
      failed: sprintTasks.filter((t) => t.status === "failed").length,
    };

    return cacheAndSend(req, reply, 200, success(`Sprint ${activeSprint.number} active.`, {
      sprint: activeSprint,
      taskCounts,
    }));
  });

  // GET /sprints/:sprintId/completion — check sprint completion readiness
  app.get<{ Params: { sprintId: string } }>(
    `${SPRINTS_BASE}/:sprintId/completion`,
    async (req, reply) => {
      const { sprintId } = req.params;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const sprint = snapshot.sprints.find((s) => s.id === sprintId);
      if (!sprint) {
        return reply.code(404).send(failure(`Sprint ${sprintId} not found.`, "not_found", "never", "sprint_exists"));
        return;
      }

      const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === sprintId);
      const total = sprintTasks.length;
      const completed = sprintTasks.filter((t) => t.status === "completed").length;
      const verified = sprintTasks.filter((t) => t.status === "completed" && t.verifierState.isVerified).length;
      const blocked = sprintTasks.filter((t) => t.status === "blocked").length;
      const failed = sprintTasks.filter((t) => t.status === "failed").length;
      const remaining = total - completed - failed;
      const readyToFinalize = remaining === 0 && blocked === 0;

      return cacheAndSend(req, reply, 200, success(`Sprint ${sprintId} completion check.`, {
        sprintId,
        total,
        completed,
        verified,
        blocked,
        failed,
        remainingRequired: remaining,
        readyToFinalize,
      }));
    },
  );

  // POST /sprints/:sprintId/qa-gate — QA agent checks sprint health (read-only)
  app.post<{ Params: { sprintId: string } }>(
    `${SPRINTS_BASE}/:sprintId/qa-gate`,
    async (req, reply) => {
      const role = req.mcp?.role;
      if (role !== "tester" && role !== "cto") {
        return reply.code(403).send(failure("QA gate requires tester or cto role.", "governance", "never", "role_is_qa_or_cto"));
        return;
      }
      const { sprintId } = req.params;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const sprint = snapshot.sprints.find((s) => s.id === sprintId);
      if (!sprint) {
        return reply.code(404).send(failure(`Sprint ${sprintId} not found.`, "not_found", "never", "sprint_exists"));
        return;
      }

      const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === sprintId);
      const completedNotVerified = sprintTasks.filter(
        (t) => t.status === "completed" && !t.verifierState?.isVerified,
      );
      const failedTasks = sprintTasks.filter((t) => t.status === "failed");
      const passed = completedNotVerified.length === 0 && failedTasks.length === 0;

      return cacheAndSend(req, reply, 200, success(`QA gate ${passed ? "passed" : "failed"}.`, {
        sprintId,
        passed,
        unverifiedTasks: completedNotVerified.map((t) => ({ id: t.id, title: t.title })),
        failedTasks: failedTasks.map((t) => ({ id: t.id, title: t.title })),
      }));
    },
  );

  // POST /sprints/:sprintId/final-gate — CTO checks build/integration readiness (read-only)
  app.post<{ Params: { sprintId: string } }>(
    `${SPRINTS_BASE}/:sprintId/final-gate`,
    async (req, reply) => {
      if (req.mcp?.role !== "cto") {
        return reply.code(403).send(failure("Final gate requires CTO role.", "governance", "never", "role_is_cto"));
        return;
      }
      const { sprintId } = req.params;
      const snapshot = await buildSnapshotView(req.mcp.companyId);
      const sprint = snapshot.sprints.find((s) => s.id === sprintId);
      if (!sprint) {
        return reply.code(404).send(failure(`Sprint ${sprintId} not found.`, "not_found", "never", "sprint_exists"));
        return;
      }

      const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === sprintId);
      const allVerified = sprintTasks.every(
        (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
      );
      const blockedCount = sprintTasks.filter((t) => t.status === "blocked").length;

      return cacheAndSend(req, reply, 200, success(`Final gate check.`, {
        sprintId,
        allVerified,
        blockedCount,
        taskSummary: {
          total: sprintTasks.length,
          verified: sprintTasks.filter((t) => t.status === "completed" && t.verifierState.isVerified).length,
          completed: sprintTasks.filter((t) => t.status === "completed" && !t.verifierState.isVerified).length,
          failed: sprintTasks.filter((t) => t.status === "failed").length,
          blocked: blockedCount,
        },
      }));
    },
  );

  // POST /sprints/:sprintId/finalize — CEO finalizes the sprint
  app.post<{ Params: { sprintId: string } }>(
    `${SPRINTS_BASE}/:sprintId/finalize`,
    async (req, reply) => {
      if (req.mcp?.role !== "ceo") {
        return reply.code(403).send(failure("Only CEO can finalize sprints.", "governance", "never", "role_is_ceo"));
        return;
      }
      const { sprintId } = req.params;
      const snapshot = await buildSnapshotView(req.mcp.companyId);
      const sprint = snapshot.sprints.find((s) => s.id === sprintId);
      if (!sprint) {
        return reply.code(404).send(failure(`Sprint ${sprintId} not found.`, "not_found", "never", "sprint_exists"));
        return;
      }
      if (sprint.status === "completed") {
        return reply.code(409).send(failure(`Sprint ${sprintId} already finalized.`, "conflict", "never", "state_reset"));
        return;
      }

      // Persist sprint completion to DB + run side effects (snapshot tag, graph emit, etc.)
      await finalizeSprintCompletion(sprintId);

      // Re-read to get the persisted state
      const updated = await buildSnapshotView(req.mcp.companyId);
      const finalizedSprint = updated.sprints.find((s) => s.id === sprintId);

      const sprintTasks = updated.tasks.filter((t) => t.sprintId === sprintId);
      const completedCount = sprintTasks.filter((t) =>
        ["completed", "verified"].includes(t.status),
      ).length;

      return cacheAndSend(req, reply, 200, success(`Sprint ${finalizedSprint?.number ?? sprint.number} finalized.`, {
        sprintId,
        sprintNumber: finalizedSprint?.number ?? sprint.number,
        completedTasks: completedCount,
        totalTasks: sprintTasks.length,
        finalizedAt: finalizedSprint?.completedAt ?? new Date().toISOString(),
      }));
    },
  );
}
