import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sendChatMessageSchema, chatCardActionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { chatService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";

export function chatRoutes(db: Db) {
  const router = Router();
  const svc = chatService(db);

  // ------- Message history -------

  router.get("/companies/:companyId/chat/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before as string | undefined;
    const messages = await svc.getHistory(companyId, limit, before);
    res.json(messages);
  });

  // ------- Send message + stream response -------

  router.post("/companies/:companyId/chat", validate(sendChatMessageSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // Store user message
    const userMsg = await svc.storeUserMessage(companyId, req.body.content);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.message_sent",
      entityType: "chat_message",
      entityId: userMsg.id,
      details: { content: req.body.content.slice(0, 200) },
    });

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send back user message ID first
    send("user_message", { id: userMsg.id });

    try {
      const ceoAgentId = await svc.getCeoAgentId(companyId);
      let fullContent = "";

      for await (const chunk of svc.streamResponse(companyId)) {
        switch (chunk.type) {
          case "token":
            if (chunk.token) {
              fullContent += chunk.token;
              send("token", { token: chunk.token });
            }
            break;
          case "done":
            if (chunk.fullContent) fullContent = chunk.fullContent;
            break;
          case "error":
            send("error", { error: chunk.token ?? "Stream error" });
            break;
        }
      }

      // Store assistant message
      const assistantMsg = await svc.storeAssistantMessage(
        companyId,
        fullContent || "(no response)",
        ceoAgentId,
      );

      send("assistant_message", { id: assistantMsg.id, message: assistantMsg });
      send("done", { messageId: assistantMsg.id });
    } catch (err) {
      logger.error({ err }, "Chat stream error");
      send("error", { error: "Failed to generate response" });
    } finally {
      res.end();
    }
  });

  // ------- Card action -------

  router.patch("/companies/:companyId/chat/messages/:messageId/card-action", validate(chatCardActionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const messageId = req.params.messageId as string;
    assertCompanyAccess(req, companyId);

    const updated = await svc.updateCardState(messageId, req.body);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `chat.card_${req.body.action}`,
      entityType: "chat_message",
      entityId: messageId,
      details: { cardType: updated.cardType, action: req.body.action },
    });

    res.json(updated);
  });

  // ------- Dev: delete all messages for a company -------

  router.delete("/companies/:companyId/chat/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { chatMessages } = await import("@paperclipai/db");
    const { eq } = await import("drizzle-orm");
    await db.delete(chatMessages).where(eq(chatMessages.companyId, companyId));
    res.json({ ok: true });
  });

  // ------- Dev: seed card test messages -------

  router.post("/companies/:companyId/chat/seed-cards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const ceoAgentId = await svc.getCeoAgentId(companyId);

    type CardSpec = { content: string; cardType: "task_proposal" | "org_plan" | "issue" | "budget_request" | "status_report" | "escalation"; cardData: Record<string, unknown> };

    const cards: CardSpec[] = [
      {
        content: "I'd like to propose a new task for our engineering team.",
        cardType: "task_proposal",
        cardData: {
          title: "Implement OAuth2 Integration",
          description: "Add OAuth2 support for the agent API to allow third-party integrations securely.",
          assigneeRole: "Backend Team",
          priority: "high",
        },
      },
      {
        content: "Based on our growth trajectory, I recommend restructuring.",
        cardType: "org_plan",
        cardData: {
          summary: "Expand engineering from 3 to 5 agents, add a dedicated QA role.",
          changes: [
            { type: "add_edge", description: "Hire 2 backend engineers" },
            { type: "add_edge", description: "Create QA Lead reporting to CTO" },
            { type: "move_agent", description: "Split frontend/backend teams" },
          ],
        },
      },
      {
        content: "We need additional budget for infrastructure.",
        cardType: "budget_request",
        cardData: {
          amount: 2500,
          currency: "USD",
          justification: "Current workloads approaching compute limits. Need 3x capacity for Q2 growth.",
        },
      },
      {
        content: "Here's the weekly status report.",
        cardType: "status_report",
        cardData: {
          summary: "All 3 active projects on track. Revenue up 12% WoW.",
          agentCount: 5,
          activeAgentCount: 4,
          openTasks: 7,
          completedTasks: 12,
          budgetSpent: 3200,
          budgetLimit: 10000,
          pendingEscalations: 1,
        },
      },
      {
        content: "Urgent: critical issue needs Board attention.",
        cardType: "escalation",
        cardData: {
          agentId: ceoAgentId ?? "unknown",
          agentName: "Marketing Bot",
          question: "Marketing agent spent 340% of budget in 5 days via misconfigured loop. Auto-paused, $1,200 spent. How should we proceed?",
          severity: "high",
        },
      },
      {
        content: "Flagging this issue for your review.",
        cardType: "issue",
        cardData: {
          title: "Flaky E2E Tests on CI",
          description: "Integration tests fail intermittently (~20%) due to heartbeat polling race conditions.",
          priority: "medium",
        },
      },
    ];

    const results = [];
    for (const card of cards) {
      const msg = await svc.storeAssistantMessage(companyId, card.content, ceoAgentId, {
        cardType: card.cardType,
        cardData: card.cardData as never,
      });
      results.push(msg);
    }

    res.json({ inserted: results.length, messages: results });
  });

  return router;
}
