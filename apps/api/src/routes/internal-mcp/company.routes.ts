/**
 * §9 Company / agent context + §10 Board routes
 * Spec 26 §9 — company_get_summary, agent_list_sessions, company_update_status
 * Spec 26 §10 — board_list_messages
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { updateCompanyStatus } from "../../persistence/mutations.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { failure, success } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const COMPANY_BASE = "/api/internal/v1/company";
const BOARD_BASE = "/api/internal/v1/board";

const cacheAndSend = (
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: unknown,
): FastifyReply => {
  cacheSuccessfulResponse(req, { status, body, locationHeader: null });
  return reply.code(status).send(body);
};

export default async function internalMcpCompanyRoutes(app: FastifyInstance): Promise<void> {
  // GET /company/summary — pure DB read of company state
  app.get(`${COMPANY_BASE}/summary`, async (req, reply) => {
    const snapshot = await buildSnapshotView(req.mcp!.companyId);
    const c = snapshot.company;
    const activeSprint = snapshot.sprints.find((s) => s.id === c.currentSprintId);

    return cacheAndSend(req, reply, 200, success("Company summary.", {
      name: c.name,
      goal: c.goal,
      status: c.status,
      activeSprint: activeSprint
        ? { id: activeSprint.id, number: activeSprint.number, goal: activeSprint.goal, status: activeSprint.status }
        : null,
      budgetCents: c.budgetCents,
      spentCents: c.spentCents,
      agentCount: snapshot.agents.length,
    }));
  });

  // GET /agents/sessions — list active beat sessions across employees
  app.get("/api/internal/v1/agents/sessions", async (req, reply) => {
    const snapshot = await buildSnapshotView(req.mcp!.companyId);
    const agents = snapshot.agents.map((a) => ({
      role: a.role,
      id: a.id,
      status: a.status ?? "idle",
    }));

    return cacheAndSend(req, reply, 200, success(`${agents.length} agents.`, {
      agents,
      totalActive: agents.filter((a) => a.status === "active" || a.status === "running").length,
    }));
  });

  // POST /company/status — CEO updates free-form status string
  app.post(`${COMPANY_BASE}/status`, async (req, reply) => {
    if (req.mcp?.role !== "ceo") {
      return reply.code(403).send(failure("Only CEO can update company status.", "governance", "never", "role_is_ceo"));
      return;
    }
    const statusBody = z.object({
      status: z.enum(["ideation", "active", "paused", "archived"]),
    });
    const parsed = statusBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send(failure("Invalid status.", "validation", "never", "payload_fixed"));
      return;
    }

    // Spec 31 Phase 7.C.d — direct canonical write keyed by the request's
    // companyId from the MCP middleware.
    await updateCompanyStatus(req.mcp.companyId, parsed.data.status);

    return cacheAndSend(req, reply, 200, success("Company status updated.", {
      status: parsed.data.status,
    }));
  });

  // GET /board/messages — paginated board message history
  app.get<{ Querystring: { since?: string; sinceSprint?: string; cardType?: string; limit?: string } }>(
    `${BOARD_BASE}/messages`,
    async (req, reply) => {
      const { since, sinceSprint, cardType, limit: limitStr } = req.query;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const limit = Math.min(parseInt(limitStr || "20", 10), 100);

      let messages = snapshot.chatMessages ?? [];

      if (since) {
        messages = messages.filter((m) => m.createdAt >= since);
      }

      if (sinceSprint) {
        const sprint = snapshot.sprints.find((s) => s.id === sinceSprint);
        if (sprint?.startedAt) {
          messages = messages.filter((m) => m.createdAt >= sprint.startedAt!);
        }
      }

      if (cardType) {
        messages = messages.filter((m) => m.cardType === cardType);
      }

      const results = messages.slice(-limit);

      return cacheAndSend(req, reply, 200, success(`${results.length} board message(s).`, {
        messages: results,
        total: results.length,
      }));
    },
  );
}
