/**
 * Spec 35 — Internal MCP endpoint backing `chat_emit_card`.
 *
 * The CEO's only path to render an interactive card in chat. Writes a
 * `board_messages` row with role=ceo + cardType + cardData, then
 * publishes a `chat.card_added` event for the live SSE stream.
 *
 * Decision capture lives in `POST /api/chat/cards/:id/decide`, not here.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  chatMessageCardTypeSchema,
  type ChatMessage,
} from "@arceus/contracts";
import { appendChatMessage } from "../../persistence/mutations/index.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { failure, success } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";
import { publishChatEvent } from "../../agents/chat-events.js";
import { noteChatCardEmitted } from "../../agents/chat-card-tracker.js";

const CHAT_CARDS = "/api/internal/v1/chat/cards";

// Card types owned by the legacy classifier (`classifyCeoResponse`).
// They are produced automatically from the CEO's streamed reply text on
// every turn; emitting them here too would render duplicate cards.
const CLASSIFIER_OWNED_CARD_TYPES = new Set([
  "strategy_proposal",
  "welcome_brief",
  "mission_brief",
  "clarifying_question",
  "status_update",
  "sprint_proposal",
]);

const emitCardInputSchema = z.object({
  type: chatMessageCardTypeSchema,
  payload: z.record(z.unknown()),
});

export default async function internalMcpChatRoutes(app: FastifyInstance): Promise<void> {
  app.post(CHAT_CARDS, async (req, reply) => {
    const parsed = emitCardInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send(
        failure("Request validation failed.", "validation", "never", "payload_fixed"),
      );
    }

    const mcp = req.mcp!;
    if (mcp.role !== "ceo") {
      return reply.code(403).send(
        failure(
          `chat_emit_card is only available to the CEO (got role '${mcp.role}').`,
          "governance",
          "never",
          "role_correct",
        ),
      );
    }

    const { type, payload } = parsed.data;
    if (CLASSIFIER_OWNED_CARD_TYPES.has(type)) {
      return reply.code(422).send(
        failure(
          `chat_emit_card cannot emit '${type}' — that card type is produced automatically by the system from your reply text. Just answer in plaintext and the system will format it. Use chat_emit_card only for: idea_refine, name_suggest, hiring_slate, sprint_plan, decision, approval_request, memory_capture, meeting_summary.`,
          "governance",
          "never",
          "card_type_corrected",
        ),
      );
    }
    const cardData = { type, ...payload } as Record<string, unknown>;

    // Pull current sprint id so the card sits in the right scope.
    const snapshot = await buildSnapshotView(mcp.companyId);

    const message: ChatMessage = {
      id: `chat_${randomUUID()}`,
      companyId: mcp.companyId,
      sprintId: snapshot.company.currentSprintId,
      agentId: null,
      role: "ceo",
      content: "",
      cardType: type,
      cardData,
      createdAt: new Date().toISOString(),
      mode: null,
      parentMessageId: null,
      cardDecision: null,
      cardDecidedAt: null,
      cardDecidedBy: null,
    };

    await appendChatMessage(message);
    publishChatEvent({ type: "chat.card_added", companyId: mcp.companyId, message });
    noteChatCardEmitted(mcp.beatId);

    const body = success(`Emitted ${type} card.`, { cardId: message.id });
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    return reply.code(200).send(body);
  });
}
