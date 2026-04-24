/**
 * @module heartbeat.routes
 * Routes for the heartbeat engine — start/stop, manual triggers, status, history, and config.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSnapshot } from "../persistence/store.js";
import { cpGetBeatHistory } from "../persistence/control-plane.js";
import type { HeartbeatEngine, MeetingScheduler, HeartbeatConfig } from "@arceus/company-runtime";
import { heartbeatConfig } from "../config/heartbeat.js";

export interface HeartbeatRouteDeps {
  heartbeatEngine: HeartbeatEngine;
  meetingScheduler: MeetingScheduler;
}

export default async function heartbeatRoutes(app: FastifyInstance, opts: HeartbeatRouteDeps) {
  const { heartbeatEngine, meetingScheduler } = opts;

  app.post("/api/heartbeat/start", async () => {
    heartbeatEngine.start();
    if (heartbeatConfig.meetingsEnabled) meetingScheduler.start();
    return { status: "started", meetingsEnabled: heartbeatConfig.meetingsEnabled, ...heartbeatEngine.getStatus() };
  });

  app.post("/api/heartbeat/stop", { logLevel: "warn" }, async () => {
    heartbeatEngine.stop();
    meetingScheduler.stop();
    return { status: "stopped", ...heartbeatEngine.getStatus() };
  });

  app.post("/api/heartbeat/trigger", async (request, reply) => {
    const body = z.object({
      agentId: z.string(),
      role: z.string(),
      trigger: z.discriminatedUnion("type", [
        z.object({ type: z.literal("interval"), scheduledAt: z.string().optional() }),
        z.object({ type: z.literal("event"), event: z.string() }),
      ]).optional(),
    }).parse(request.body);

    const snapshot = getSnapshot();
    if (snapshot.company.id === "company_pending") {
      reply.code(400);
      return { error: "No company bootstrapped yet." };
    }

    const trigger = body.trigger ?? { type: "interval" as const, scheduledAt: new Date().toISOString() };
    if (trigger.type === "interval" && !trigger.scheduledAt) {
      (trigger as any).scheduledAt = new Date().toISOString();
    }

    const record = await heartbeatEngine.triggerBeat({
      companyId: snapshot.company.id,
      agentId: body.agentId,
      role: body.role as any,
      trigger: trigger as any,
    });

    return record ?? { status: "skipped", reason: "Beat was skipped (locked, paused, or at capacity)" };
  });

  app.get("/api/heartbeat/status", { logLevel: "warn" }, async () => {
    const { heartbeatConfig } = await import("../config/heartbeat.js");
    return {
      ...heartbeatEngine.getStatus(),
      config: {
        executionMode: heartbeatConfig.executionMode,
        schedulerIntervalMs: heartbeatConfig.schedulerIntervalMs,
        maxConcurrentBeats: heartbeatConfig.maxConcurrentBeats,
      },
    };
  });

  app.get("/api/heartbeat/history", async (request) => {
    const companyId = getSnapshot().company.id;
    if (companyId === "company_pending") return [];
    const query = request.query as Record<string, string>;
    const limit = query.limit ? Math.min(Number(query.limit), 500) : 100;
    const agentId = query.agentId || undefined;
    const dbHistory = await cpGetBeatHistory(companyId, { limit, agentId });
    return dbHistory.length > 0 ? dbHistory : heartbeatEngine.getHistory(companyId);
  });

  app.patch("/api/heartbeat/config", async (request) => {
    const body = request.body as Record<string, unknown>;
    const allowed: (keyof HeartbeatConfig)[] = [
      "schedulerIntervalMs", "maxConcurrentBeats", "beatTimeoutMs",
      "beatTokenBudget", "beatCostCeilingCents", "pauseWhenNoActiveSprint",
      "pauseWhenBudgetExhausted",
    ];
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) patch[key] = body[key];
    }
    heartbeatEngine.patchConfig(patch as any);
    return { config: heartbeatEngine.getConfig() };
  });
}
