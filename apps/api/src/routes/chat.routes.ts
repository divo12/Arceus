/**
 * @module chat.routes
 * Routes for board-to-CEO chat (send and SSE stream).
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getActiveCompanyId, requireActiveCompanyId } from "../persistence/active-company.js";
import { audit } from "../observability/audit-ledger.js";
import { sendBoardMessageToCeo, streamBoardMessageToCeo } from "../agents/chat.js";
import { sanitizeError } from "../observability/sanitize.js";
import { getDb } from "@arceus/db";
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";
import { appendChatMessage } from "../persistence/mutations/index.js";
import { publishChatEvent, subscribeChat } from "../agents/chat-events.js";

const chatSchema = z.object({
  message: z.string().min(1),
});

const messagesPostSchema = z.object({
  message: z.string().min(1),
  mode: z.enum(["ask", "instruct", "store"]).default("instruct"),
});

const decideSchema = z.object({
  decision: z.record(z.unknown()),
  decidedBy: z.string().default("user"),
  /** Optional human-readable label injected into the synthetic user message. */
  label: z.string().optional(),
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
      return sanitizeError(error, "CEO chat failed.", {
        route: "POST /api/chat/ceo",
        companyId: getActiveCompanyId() ?? undefined,
      });
    }
  });

  app.get("/api/chat/ceo/stream", async (request, reply) => {
    try {
      const query = z.object({
        message: z.string().min(1),
        mode: z.enum(["ask", "instruct", "store"]).default("instruct"),
      }).parse(request.query);
      await streamBoardMessageToCeo(reply, query.message, query.mode);
      return reply;
    } catch (error) {
      request.log?.error?.(error);
      if (!reply.raw.headersSent && !reply.sent) {
        reply.code(500);
        return sanitizeError(error, "CEO stream failed.", {
          route: "GET /api/chat/ceo/stream",
          companyId: getActiveCompanyId() ?? undefined,
        });
      }
      // SSE headers already flushed — frontend EventSource is open. We must
      // write an explicit `error` event before closing or the UI hangs in
      // its skeleton/loading state forever (no signal that the stream died).
      try {
        const message = error instanceof Error ? error.message : "CEO stream failed.";
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      } catch { /* stream already broken */ }
      try { reply.raw.end(); } catch { /* already ended */ }
      return reply;
    }
  });

  // ── Spec 35 — chat surface ──────────────────────────────────────

  /** POST a user message + mode and stream the CEO reply (SSE). */
  app.post("/api/chat/messages", async (request, reply) => {
    try {
      const body = messagesPostSchema.parse(request.body);
      audit({
        companyId: getActiveCompanyId() ?? "",
        category: "board",
        eventType: "board_message_sent",
        summary: `Board (${body.mode}) → CEO: ${body.message.slice(0, 100)}${body.message.length > 100 ? "…" : ""}`,
      });
      await streamBoardMessageToCeo(reply, body.message, body.mode);
      return reply;
    } catch (error) {
      request.log?.error?.(error);
      if (!reply.raw.headersSent && !reply.sent) {
        reply.code(500);
        return sanitizeError(error, "Chat send failed.", {
          route: "POST /api/chat/messages",
          companyId: getActiveCompanyId() ?? undefined,
        });
      }
      try { reply.raw.end(); } catch { /* already ended */ }
      return reply;
    }
  });

  /** Paginated transcript for the active company (newest first, last 100). */
  app.get("/api/chat/history", async (request, reply) => {
    try {
      const query = z.object({
        limit: z.coerce.number().int().positive().max(500).default(100),
      }).parse(request.query);
      const companyId = getActiveCompanyId();
      if (!companyId) {
        return { messages: [] };
      }
      const rows = await boardMessagesRepo.listBoardMessages(getDb(), companyId, query.limit);
      const messages = rows.map(boardMessagesRepo.rowToChatMessage).reverse();
      return { messages };
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return sanitizeError(error, "Chat history failed.", {
        route: "GET /api/chat/history",
        companyId: getActiveCompanyId() ?? undefined,
      });
    }
  });

  /**
   * Capture a user decision on a card. Atomic — second click is a no-op.
   * Injects a synthetic user message ("[user picked: X]") into the
   * transcript so the next CEO turn naturally sees the resolution.
   */
  app.post("/api/chat/cards/:id/decide", async (request, reply) => {
    try {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = decideSchema.parse(request.body);
      const companyId = requireActiveCompanyId();

      const updated = await boardMessagesRepo.markCardDecided(
        getDb(),
        params.id,
        body.decision,
        body.decidedBy,
      );
      if (!updated) {
        // Either not a card, or already decided — return current row idempotently.
        const existing = await boardMessagesRepo.findByIdHydrated(getDb(), params.id);
        if (!existing) {
          reply.code(404);
          return { error: "card_not_found" };
        }
        return { card: existing, alreadyDecided: true };
      }

      const cardMessage = boardMessagesRepo.rowToChatMessage(updated);
      publishChatEvent({ type: "chat.card_decided", companyId, message: cardMessage });

      // Synthetic user message — short, structured, parsable.
      const label = body.label ?? JSON.stringify(body.decision);
      const synthetic = await appendChatMessage({
        id: `chat_${randomUUID()}`,
        companyId,
        sprintId: cardMessage.sprintId,
        agentId: null,
        role: "board",
        content: `[user decided ${cardMessage.cardType ?? "card"}: ${label}]`,
        cardType: null,
        cardData: null,
        createdAt: new Date().toISOString(),
        mode: "instruct",
        parentMessageId: cardMessage.id,
        cardDecision: null,
        cardDecidedAt: null,
        cardDecidedBy: null,
      });
      publishChatEvent({ type: "chat.message_added", companyId, message: synthetic });

      return { card: cardMessage, syntheticMessage: synthetic };
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return sanitizeError(error, "Card decide failed.", {
        route: "POST /api/chat/cards/:id/decide",
        companyId: getActiveCompanyId() ?? undefined,
      });
    }
  });

  /**
   * Live SSE for chat events (messages, cards, tokens, turn boundaries).
   * Filtered by active company. No history replay — clients pull
   * history from `/api/chat/history` on connect.
   */
  app.get("/api/chat/stream", async (request, reply) => {
    const companyId = getActiveCompanyId();
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*");
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    reply.raw.flushHeaders?.();

    const heartbeat = setInterval(() => {
      try { reply.raw.write(`event: ping\ndata: {}\n\n`); }
      catch { clearInterval(heartbeat); }
    }, 10_000);

    const unsubscribe = subscribeChat((ev) => {
      if (companyId && "companyId" in ev && ev.companyId !== companyId) return;
      try {
        reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    return reply;
  });
}

