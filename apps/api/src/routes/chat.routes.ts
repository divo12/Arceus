/**
 * @module chat.routes
 * Routes for board-to-CEO chat (send and SSE stream).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { audit } from "../observability/audit-ledger.js";
import { sendBoardMessageToCeo, streamBoardMessageToCeo } from "../agents/chat.js";

const chatSchema = z.object({
  message: z.string().min(1),
});

export default async function chatRoutes(app: FastifyInstance) {
  app.post("/api/chat/ceo", async (request, reply) => {
    try {
      const body = chatSchema.parse(request.body);
      audit({ companyId: getActiveCompanyId() ?? "", category: "board", eventType: "board_message_sent", summary: `Board → CEO: ${body.message.slice(0, 100)}${body.message.length > 100 ? "…" : ""}` });
      return await sendBoardMessageToCeo(body.message);
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Unknown CEO chat failure",
      };
    }
  });

  app.get("/api/chat/ceo/stream", async (request, reply) => {
    try {
      const query = z.object({ message: z.string().min(1) }).parse(request.query);
      await streamBoardMessageToCeo(reply, query.message);
      return reply;
    } catch (error) {
      request.log?.error?.(error);
      if (!reply.raw.headersSent && !reply.sent) {
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : "Unknown CEO stream failure",
        };
      }
      // eslint-disable-next-line no-restricted-syntax -- intentional: SSE end on already-closed reply; finalizer.
      try { reply.raw.end(); } catch { /* already ended */ }
      return reply;
    }
  });
}
