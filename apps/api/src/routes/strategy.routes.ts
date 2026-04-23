/**
 * @module strategy.routes
 * Routes for strategy generation, approval, execution, and quick-execute bootstrap flow.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSnapshot, applyStrategy } from "../persistence/store.js";
import { audit } from "../observability/audit-ledger.js";
import { emitActivity } from "../observability/activity.js";
import { strategyOutputSchema, generateStrategy } from "../agents/ceo.js";
import { seedRegistry } from "../governance/service-registry.js";
import { bootstrapIdeaWithWorkspace } from "../orchestration/bootstrap.js";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";

export interface StrategyRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function strategyRoutes(app: FastifyInstance, opts: StrategyRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  app.post("/api/company/strategy", async (request, reply) => {
    try {
      const { sendBoardMessageToCeo } = await import("../agents/chat.js");
      audit({ companyId: getSnapshot().company.id, category: "board", eventType: "strategy_requested", summary: "Board requested CEO strategy generation" });
      return await sendBoardMessageToCeo(getSnapshot().company.goal || "Refine the current idea into a demoable first release.");
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Unknown strategy generation failure",
      };
    }
  });

  app.post("/api/strategy/approve", async (request, reply) => {
    try {
      const body = strategyOutputSchema.parse(request.body);
      return applyStrategy(body);
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Invalid strategy payload",
      };
    }
  });

  app.post("/api/strategy/execute", async (request, reply) => {
    try {
      const body = strategyOutputSchema.parse(request.body);
      const snapshot = applyStrategy(body);

      heartbeatEngine.start();
      meetingScheduler.start();

      return { snapshot, status: "heartbeat_started", mode: "heartbeat" };
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Invalid strategy payload",
      };
    }
  });

  // Quick execute: bootstrap → strategy → apply → execute
  const quickExecuteSchema = z.object({
    idea: z.string().min(5),
  });

  app.post("/api/quick-execute", async (request, reply) => {
    try {
      const { idea } = quickExecuteSchema.parse(request.body);
      emitActivity("system", "transition", `Quick-execute started: "${idea.slice(0, 80)}"`);

      let snapshot = getSnapshot();
      if (snapshot.company.id === "company_pending") {
        emitActivity("system", "transition", "Bootstrapping company...");
        snapshot = (await bootstrapIdeaWithWorkspace(idea)).snapshot;
        await seedRegistry(snapshot.company.id);
        emitActivity("system", "transition", `Company bootstrapped: ${snapshot.company.name}`);
      }

      emitActivity("ceo", "transition", "CEO generating strategy...");
      const strategy = await generateStrategy(snapshot);
      emitActivity("ceo", "transition", `Strategy ready: ${strategy.strategy_title}`);

      snapshot = applyStrategy(strategy);
      emitActivity("system", "transition", `Strategy applied — ${snapshot.agents.length} agents, ${snapshot.tasks.length} tasks`);

      heartbeatEngine.start();
      meetingScheduler.start();
      emitActivity("system", "transition", "Heartbeat started — agents are now autonomous");

      return { snapshot, strategy, status: "heartbeat_started", mode: "heartbeat" };
    } catch (error) {
      request.log?.error?.(error);
      emitActivity("system", "error", `Quick-execute failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Quick execute failed.",
      };
    }
  });
}
