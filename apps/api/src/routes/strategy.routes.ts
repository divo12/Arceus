/**
 * @module strategy.routes
 * Routes for strategy generation, approval, execution, and quick-execute bootstrap flow.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";
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

  app.post("/api/company/strategy", { preHandler: [requireUserAuth] }, async (request, reply) => {
    try {
      const { sendBoardMessageToCeo } = await import("../agents/chat.js");
      // Native multi-tenant: resolve the tenant from the caller's JWT only.
      // No global current-company fallback — an unauthenticated caller gets the
      // generic refine prompt below rather than some other tenant's company.
      const companyId = request.companyId;
      audit({ companyId: companyId ?? "", category: "board", eventType: "strategy_requested", summary: "Board requested CEO strategy generation" });
      const company = companyId ? await companiesRepo.findByIdHydrated(getDb(), companyId) : null;
      return await sendBoardMessageToCeo(company?.goal || "Refine the current idea into a demoable first release.");
    } catch (error) {
      request.log?.error?.(error);
      reply.code(500);
      return sanitizeError(error, "Strategy generation failed.", {
        route: "POST /api/strategy",
        companyId: request.companyId ?? undefined,
      });
    }
  });

  app.post("/api/strategy/approve", { preHandler: [requireUserAuth] }, async (request, reply) => {
    try {
      const body = strategyOutputSchema.parse(request.body);
      // Spec 31 Phase 7.C.c-bis — applyStrategyTx is atomic; it either
      // commits the entire org chart or rolls back. Surface a 409 if the
      // caller has no company in session so the board can retry.
      const companyId = request.companyId;
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
        companyId: request.companyId ?? undefined,
      });
    }
  });

  app.post("/api/strategy/execute", { preHandler: [requireUserAuth] }, async (request, reply) => {
    try {
      const body = strategyOutputSchema.parse(request.body);
      const companyId = request.companyId;
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
        companyId: request.companyId ?? undefined,
      });
    }
  });

  // Quick execute: bootstrap → strategy → apply → execute
  const quickExecuteSchema = z.object({
    idea: z.string().min(5),
  });

  app.post("/api/quick-execute", { preHandler: [requireUserAuth] }, async (request, reply) => {
    try {
      const { idea } = quickExecuteSchema.parse(request.body);
      emitActivity("system", "transition", `Quick-execute started: "${idea.slice(0, 80)}"`);

      // Spec 31 Phase 7.C.c — bootstrap if needed, then assemble the
      // snapshot from canonical for `generateStrategy`. `bootstrapIdea-
      // WithWorkspace` returns a snapshot directly so we use it; afterward
      // each stage rebuilds from canonical so the CEO LLM sees the
      // up-to-date view.
      //
      // Native multi-tenant: when the caller is authenticated, start from
      // their JWT company. Otherwise bootstrap a NEW company and carry its id
      // forward directly (snapshot.company.id) — never read it back from a
      // global pointer, which is what coupled this flow to the wrong tenant.
      let snapshot;
      let companyId: string;
      if (!request.companyId) {
        emitActivity("system", "transition", "Bootstrapping company...");
        snapshot = (await bootstrapIdeaWithWorkspace(idea)).snapshot;
        companyId = snapshot.company.id;
        emitActivity("system", "transition", `Company bootstrapped: ${snapshot.company.name}`);
      } else {
        companyId = request.companyId;
        snapshot = await buildSnapshotView(companyId);
      }

      emitActivity("ceo", "transition", "CEO generating strategy...");
      const strategy = await generateStrategy(snapshot);
      emitActivity("ceo", "transition", `Strategy ready: ${strategy.strategy_title}`);

      // Spec 31 Phase 7.C.c-bis — applyStrategyTx commits org chart atomically.
      await applyStrategyTx(companyId, strategy);
      snapshot = await buildSnapshotView(companyId);
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
        companyId: request.companyId ?? undefined,
      });
    }
  });
}
