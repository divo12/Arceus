/**
 * §6 Execution-cycle routes
 * Spec 27 — execution_get, execution_complete_cycle, execution_pause_for_review,
 *            execution_reconcile_post_review, execution_stop
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSnapshot } from "../../persistence/store.js";
import { failure, success } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const EXEC_BASE = "/api/internal/v1/execution";

const cacheAndSend = (
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: unknown,
): void => {
  cacheSuccessfulResponse(req, { status, body, locationHeader: null });
  reply.code(status).send(body);
};

export default async function internalMcpExecutionRoutes(app: FastifyInstance): Promise<void> {
  // GET /execution — current execution cycle status
  app.get(EXEC_BASE, async (req, reply) => {
    const snapshot = getSnapshot();
    const company = snapshot.company;
    const activeSprint = snapshot.sprints.find((s) => s.id === company.currentSprintId);

    cacheAndSend(req, reply, 200, success("Execution status.", {
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
      reply.code(403).send(failure("Only CEO can complete execution cycles.", "governance", "never", "role_is_ceo"));
      return;
    }

    const snapshot = getSnapshot();
    const sprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
    if (!sprint) {
      reply.code(404).send(failure("No active sprint to complete.", "not_found", "never", "sprint_exists"));
      return;
    }

    if (sprint.status !== "completed") {
      reply.code(409).send(failure(
        `Sprint ${sprint.number} is "${sprint.status}" — finalize before completing cycle.`,
        "sprint_not_executing", "never", "sprint_finalized",
      ));
      return;
    }

    snapshot.company.status = "active";
    const now = new Date().toISOString();

    cacheAndSend(req, reply, 200, success(`Cycle complete. Ready for next sprint.`, {
      completedSprintId: sprint.id,
      completedSprintNumber: sprint.number,
      newStatus: "active",
      completedAt: now,
    }));
  });

  // POST /execution/pause — CEO pauses execution for review
  app.post(`${EXEC_BASE}/pause`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      reply.code(403).send(failure("Only CEO can pause execution.", "governance", "never", "role_is_ceo"));
      return;
    }

    const pauseBody = z.object({
      reason: z.string().max(500).optional(),
    });
    const parsed = pauseBody.safeParse(req.body);
    const reason = parsed.success ? parsed.data.reason : undefined;

    const snapshot = getSnapshot();
    snapshot.company.status = "paused";

    cacheAndSend(req, reply, 200, success("Execution paused.", {
      status: "paused",
      reason: reason ?? null,
      pausedAt: new Date().toISOString(),
    }));
  });

  // POST /execution/reconcile — CEO reconciles state after human review
  app.post(`${EXEC_BASE}/reconcile`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      reply.code(403).send(failure("Only CEO can reconcile.", "governance", "never", "role_is_ceo"));
      return;
    }

    const reconcileBody = z.object({
      notes: z.string().max(2000).optional(),
      resumeExecution: z.boolean().default(true),
    });
    const parsed = reconcileBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send(failure("Invalid reconcile body.", "validation", "never", "payload_fixed"));
      return;
    }

    const snapshot = getSnapshot();
    if (parsed.data.resumeExecution) {
      snapshot.company.status = "active";
    }

    cacheAndSend(req, reply, 200, success("Post-review reconciliation done.", {
      status: snapshot.company.status,
      resumed: parsed.data.resumeExecution,
      notes: parsed.data.notes ?? null,
      reconciledAt: new Date().toISOString(),
    }));
  });

  // POST /execution/stop — CEO halts the company entirely
  app.post(`${EXEC_BASE}/stop`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      reply.code(403).send(failure("Only CEO can stop execution.", "governance", "never", "role_is_ceo"));
      return;
    }

    const snapshot = getSnapshot();
    snapshot.company.status = "archived";

    cacheAndSend(req, reply, 200, success("Execution stopped.", {
      status: "archived",
      stoppedAt: new Date().toISOString(),
    }));
  });
}
