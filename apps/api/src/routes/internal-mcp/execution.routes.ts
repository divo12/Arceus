/**
 * §6 Execution-cycle routes
 * Spec 27 — execution_get, execution_complete_cycle, execution_pause_for_review,
 *            execution_reconcile_post_review, execution_stop
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { updateCompanyStatus } from "../../persistence/mutations/index.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { failure, success } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const EXEC_BASE = "/api/internal/v1/execution";

const cacheAndSend = (
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: unknown,
): FastifyReply => {
  cacheSuccessfulResponse(req, { status, body, locationHeader: null });
  return reply.code(status).send(body);
};

export default async function internalMcpExecutionRoutes(app: FastifyInstance): Promise<void> {
  // GET /execution — current execution cycle status
  app.get(EXEC_BASE, async (req, reply) => {
    const snapshot = await buildSnapshotView(req.mcp!.companyId);
    const company = snapshot.company;
    const activeSprint = snapshot.sprints.find((s) => s.id === company.currentSprintId);

    return cacheAndSend(req, reply, 200, success("Execution status.", {
      status: company.status,
      currentCycle: {
        sprintId: activeSprint?.id ?? null,
        sprintNumber: activeSprint?.number ?? null,
        sprintStatus: activeSprint?.status ?? null,
      },
      agentCount: snapshot.agents.length,
    }));
  });

  // POST /execution/complete-cycle — CEO marks current cycle done → planning next
  app.post(`${EXEC_BASE}/complete-cycle`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      return reply.code(403).send(failure("Only CEO can complete execution cycles.", "governance", "never", "role_is_ceo"));
      return;
    }

    const snapshot = await buildSnapshotView(req.mcp.companyId);
    const sprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
    if (!sprint) {
      return reply.code(404).send(failure("No active sprint to complete.", "not_found", "never", "sprint_exists"));
      return;
    }

    if (sprint.status !== "completed") {
      return reply.code(409).send(failure(
        `Sprint ${sprint.number} is "${sprint.status}" — finalize before completing cycle.`,
        "sprint_not_executing", "never", "sprint_finalized",
      ));
      return;
    }

    // Spec 31 Phase 7.C.d — direct canonical write keyed by request companyId.
    await updateCompanyStatus(req.mcp.companyId, "active");
    const now = new Date().toISOString();

    return cacheAndSend(req, reply, 200, success(`Cycle complete. Ready for next sprint.`, {
      completedSprintId: sprint.id,
      completedSprintNumber: sprint.number,
      newStatus: "active",
      completedAt: now,
    }));
  });

  // POST /execution/pause — CEO pauses execution for review
  app.post(`${EXEC_BASE}/pause`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      return reply.code(403).send(failure("Only CEO can pause execution.", "governance", "never", "role_is_ceo"));
      return;
    }

    const pauseBody = z.object({
      reason: z.string().max(500).optional(),
    });
    const parsed = pauseBody.safeParse(req.body);
    const reason = parsed.success ? parsed.data.reason : undefined;

    await updateCompanyStatus(req.mcp.companyId, "paused");

    return cacheAndSend(req, reply, 200, success("Execution paused.", {
      status: "paused",
      reason: reason ?? null,
      pausedAt: new Date().toISOString(),
    }));
  });

  // POST /execution/reconcile — CEO reconciles state after human review
  app.post(`${EXEC_BASE}/reconcile`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      return reply.code(403).send(failure("Only CEO can reconcile.", "governance", "never", "role_is_ceo"));
      return;
    }

    const reconcileBody = z.object({
      notes: z.string().max(2000).optional(),
      resumeExecution: z.boolean().default(true),
    });
    const parsed = reconcileBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send(failure("Invalid reconcile body.", "validation", "never", "payload_fixed"));
      return;
    }

    if (parsed.data.resumeExecution) {
      await updateCompanyStatus(req.mcp.companyId, "active");
    }
    const snapshot = await buildSnapshotView(req.mcp.companyId);

    return cacheAndSend(req, reply, 200, success("Post-review reconciliation done.", {
      status: snapshot.company.status,
      resumed: parsed.data.resumeExecution,
      notes: parsed.data.notes ?? null,
      reconciledAt: new Date().toISOString(),
    }));
  });

  // POST /execution/stop — CEO halts the company entirely
  app.post(`${EXEC_BASE}/stop`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      return reply.code(403).send(failure("Only CEO can stop execution.", "governance", "never", "role_is_ceo"));
      return;
    }

    await updateCompanyStatus(req.mcp.companyId, "archived");

    return cacheAndSend(req, reply, 200, success("Execution stopped.", {
      status: "archived",
      stoppedAt: new Date().toISOString(),
    }));
  });
}
