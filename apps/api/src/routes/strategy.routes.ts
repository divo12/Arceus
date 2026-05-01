/**
 * @module strategy.routes
 * Routes for strategy generation, approval, execution, and quick-execute bootstrap flow.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getActiveCompanyId, requireActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { applyStrategyTx } from "../sprints/strategy.js";
import { getDb } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { audit } from "../observability/audit-ledger.js";
import { emitActivity } from "../observability/activity.js";
import { sanitizeError } from "../observability/sanitize.js";
import { strategyOutputSchema, generateStrategy } from "../agents/ceo.js";
import { bootstrapIdeaWithWorkspace } from "../orchestration/bootstrap.js";
import type { HeartbeatEngine, MeetingScheduler } from "@arceus/company-runtime";
import { heartbeatConfig } from "../config/heartbeat.js";

interface StrategyRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function strategyRoutes(app: FastifyInstance, opts: StrategyRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  app.post("/api/company/strategy", async (request, reply) => {
    try {
      const { sendBoardMessageToCeo } = await import("../agents/chat.js");
      const companyId = getActiveCompanyId();
      audit({ companyId: companyId ?? "", category: "board", eventType: "strategy_requested", summary: "Board requested CEO strategy generation" });
      const company = companyId ? await companiesRepo.findByIdHydrated(getDb(), companyId) : null;
      return await sendBoardMessageToCeo(company?.goal || "Refine the current idea into a demoable first release.");
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return sanitizeError(error, "Strategy generation failed.", {
        route: "POST /api/strategy",
        companyId: getActiveCompanyId() ?? undefined,
      });
    }
  });

  app.post("/api/strategy/approve", async (request, reply) => {
    try {
      const body = strategyOutputSchema.parse(request.body);
      // Spec 31 Phase 7.C.c-bis — applyStrategyTx is atomic; it either
      // commits the entire org chart or rolls back. Surface a 409 if no
      // company has been bootstrapped yet so the board can retry.
      const companyId = getActiveCompanyId();
      if (!companyId) {
        reply.code(409);
        return { error: "No active company to apply strategy to." };
      }
      await applyStrategyTx(companyId, body);
      return await buildSnapshotView(companyId);
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return sanitizeError(error, "Strategy payload rejected.", {
        route: "POST /api/strategy/approve",
        companyId: getActiveCompanyId() ?? undefined,
      });
    }
  });

  app.post("/api/strategy/execute", async (request, reply) => {
    try {
      const body = strategyOutputSchema.parse(request.body);
      const companyId = getActiveCompanyId();
      if (!companyId) {
        reply.code(409);
        return { error: "No active company to apply strategy to." };
      }
      await applyStrategyTx(companyId, body);
      const snapshot = await buildSnapshotView(companyId);

      heartbeatEngine.start();
      if (heartbeatConfig.meetingsEnabled) meetingScheduler.start();

      return { snapshot, status: "heartbeat_started", mode: "heartbeat" };
    } catch (error) {
      request.log?.error?.(error);
      reply.code(400);
      return sanitizeError(error, "Strategy payload rejected.", {
        route: "POST /api/strategy/execute",
        companyId: getActiveCompanyId() ?? undefined,
      });
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

      // Spec 31 Phase 7.C.c — bootstrap if needed, then assemble the
      // snapshot from canonical for `generateStrategy`. `bootstrapIdea-
      // WithWorkspace` returns a snapshot directly so we use it; afterward
      // each stage rebuilds from canonical so the CEO LLM sees the
      // up-to-date view.
      let snapshot;
      if (!getActiveCompanyId()) {
        emitActivity("system", "transition", "Bootstrapping company...");
        snapshot = (await bootstrapIdeaWithWorkspace(idea)).snapshot;
        emitActivity("system", "transition", `Company bootstrapped: ${snapshot.company.name}`);
      } else {
        snapshot = await buildSnapshotView(requireActiveCompanyId());
      }

      emitActivity("ceo", "transition", "CEO generating strategy...");
      const strategy = await generateStrategy(snapshot);
      emitActivity("ceo", "transition", `Strategy ready: ${strategy.strategy_title}`);

      // Spec 31 Phase 7.C.c-bis — applyStrategyTx commits org chart atomically.
      await applyStrategyTx(requireActiveCompanyId(), strategy);
      snapshot = await buildSnapshotView(requireActiveCompanyId());
      emitActivity("system", "transition", `Strategy applied — ${snapshot.agents.length} agents, ${snapshot.tasks.length} tasks`);

      heartbeatEngine.start();
      if (heartbeatConfig.meetingsEnabled) meetingScheduler.start();
      emitActivity("system", "transition", "Heartbeat started — agents are now autonomous");

      return { snapshot, strategy, status: "heartbeat_started", mode: "heartbeat" };
    } catch (error) {
      request.log?.error?.(error);
      emitActivity("system", "error", `Quick-execute failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      reply.code(400);
      return sanitizeError(error, "Quick execute failed.", {
        route: "POST /api/quick-execute",
        companyId: getActiveCompanyId() ?? undefined,
      });
    }
  });
}
