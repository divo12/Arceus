/** @module sprints.routes — Routes for sprint listing and proposal approval/rejection. */
import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";
import { approveSprintProposal, rejectSprintProposal } from "../sprints/proposals.js";
import type { CeoCard } from "../agents/ceo.js";

export default async function sprintsRoutes(app: FastifyInstance) {
  app.get("/api/sprints", async () => {
    return getSnapshot().sprints;
  });

  app.post("/api/sprint-proposal/approve", async (request, reply) => {
    try {
      const body = request.body as { card?: unknown };
      if (!body?.card) {
        const snapshot = getSnapshot();
        const proposalMsg = [...snapshot.chatMessages].reverse().find((m) => m.cardType === "sprint_proposal");
        if (!proposalMsg?.cardData) {
          reply.code(400);
          return { error: "No sprint proposal found to approve." };
        }
        return await approveSprintProposal(proposalMsg.cardData as CeoCard);
      }
      return await approveSprintProposal(body.card as CeoCard);
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Sprint proposal approval failed.",
      };
    }
  });

  app.post("/api/sprint-proposal/reject", async (_request, reply) => {
    try {
      return rejectSprintProposal();
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Sprint proposal rejection failed.",
      };
    }
  });
}
