import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSnapshot } from "../../persistence/store.js";
import { cpGetBeatHistory } from "../../persistence/control-plane.js";
import { getAgentByRole } from "@arceus/task-engine";
import { success, failure } from "./envelope.js";

const BEATS_BASE = "/api/internal/v1/beats";

export default async function internalMcpBeatsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/internal/v1/beats/recent
   *
   * Returns the last N beat progress notes for the calling role.
   * Query params:
   *   n — number of beats to return (1–10, default 3)
   *
   * Role + companyId resolved from session context by middleware.
   */
  app.get(`${BEATS_BASE}/recent`, async (req: FastifyRequest, reply: FastifyReply) => {
    const { role, companyId } = (req as any).mcpContext ?? {};
    if (!role || !companyId) {
      reply.code(400).send(failure("Missing role or companyId in request context.", "session_required", "never", "session_provided"));
      return;
    }

    const query = (req.query ?? {}) as Record<string, string>;
    const n = Math.min(Math.max(parseInt(query.n ?? "3", 10) || 3, 1), 10);

    const snapshot = getSnapshot();
    const agent = getAgentByRole(snapshot, role);
    if (!agent) {
      reply.code(404).send(failure(`No agent found for role "${role}".`, "not_found", "never", "agent_exists"));
      return;
    }

    const beats = await cpGetBeatHistory(companyId, { agentId: agent.id, limit: n });

    const progressNotes = beats.map((beat) => ({
      beatId: beat.id,
      beatNumber: beat.beatNumber,
      status: beat.status,
      outcome: beat.outcome,
      summary: beat.summary,
      startedAt: beat.startedAt,
      endedAt: beat.endedAt,
      totalTokens: beat.totalTokens,
    }));

    reply.code(200).send(success(`Last ${progressNotes.length} beat(s) for ${role}.`, { notes: progressNotes }));
  });
}
