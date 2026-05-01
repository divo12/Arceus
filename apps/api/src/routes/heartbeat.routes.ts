/**
 * @module heartbeat.routes
 * Routes for the heartbeat engine — start/stop, manual triggers, status, history, and config.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { roleTypeSchema, beatTriggerSchema, beatEventTriggerSchema } from "@arceus/contracts";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { cpGetBeatHistory } from "../persistence/control-plane/index.js";
import type { HeartbeatEngine, MeetingScheduler, HeartbeatConfig } from "@arceus/company-runtime";
import { heartbeatConfig } from "../config/heartbeat.js";
import { parseListLimit } from "./_helpers.js";

/**
 * Body for `POST /api/heartbeat/trigger`. Trigger is the contract
 * `BeatTrigger` (interval | event) with `scheduledAt` made optional —
 * the route fills it in if the caller omits it.
 */
const triggerBodySchema = z.object({
  agentId: z.string(),
  role: roleTypeSchema,
  trigger: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("interval"), scheduledAt: z.string().optional() }),
      z.object({ type: z.literal("event"), event: beatEventTriggerSchema }),
    ])
    .optional(),
});

/**
 * Body for `PATCH /api/heartbeat/config`. Only the runtime-tunable subset
 * is exposed — role intervals, execution mode, and pause-roles are static
 * config and reload via env vars, not API patches.
 */
const heartbeatConfigPatchSchema = z.object({
  schedulerIntervalMs: z.number().int().positive().optional(),
  maxConcurrentBeats: z.number().int().positive().optional(),
  beatTimeoutMs: z.number().int().positive().optional(),
  beatTokenBudget: z.number().int().nonnegative().optional(),
  beatCostCeilingCents: z.number().int().nonnegative().optional(),
  pauseWhenNoActiveSprint: z.boolean().optional(),
  pauseWhenBudgetExhausted: z.boolean().optional(),
}) satisfies z.ZodType<Partial<Pick<
  HeartbeatConfig,
  | "schedulerIntervalMs"
  | "maxConcurrentBeats"
  | "beatTimeoutMs"
  | "beatTokenBudget"
  | "beatCostCeilingCents"
  | "pauseWhenNoActiveSprint"
  | "pauseWhenBudgetExhausted"
>>>;

interface HeartbeatRouteDeps {
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
    const parsed = triggerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid trigger body",
        details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      };
    }
    const body = parsed.data;

    const companyId = getActiveCompanyId();
    if (!companyId) {
      reply.code(400);
      return { error: "No company bootstrapped yet." };
    }

    // Normalise to the contract `BeatTrigger` shape: `interval` requires
    // `scheduledAt`. The schema accepts it as optional so callers can omit
    // it and let the server stamp `now`.
    const now = new Date().toISOString();
    const trigger: z.infer<typeof beatTriggerSchema> =
      body.trigger?.type === "event"
        ? body.trigger
        : { type: "interval", scheduledAt: body.trigger?.scheduledAt ?? now };

    const record = await heartbeatEngine.triggerBeat({
      companyId,
      agentId: body.agentId,
      role: body.role,
      trigger,
    });

    if (record) return record;

    // Audit C13 (F-435): beat skip is a concurrency/state rejection, not success.
    // 200 OK with `{ status: "skipped" }` made client monitoring unable to
    // distinguish a successful triggered beat from one throttled by a lock,
    // pause, or capacity ceiling. 409 Conflict is the right semantic
    // (per RFC 7231 — request conflicts with current resource state).
    reply.code(409);
    return {
      error: {
        code: "beat_skipped",
        message: "Beat was skipped (locked, paused, or at capacity).",
      },
    };
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
    const companyId = getActiveCompanyId();
    if (!companyId) return [];
    const query = request.query as Record<string, string>;
    // Audit C13 (F-434): NaN-safe limit parse. `Math.min(Number(garbage), 500)` was
    // returning NaN which Postgres rejected on the LIMIT clause.
    const limit = parseListLimit(query.limit, { default: 100 });
    const agentId = query.agentId || undefined;
    const dbHistory = await cpGetBeatHistory(companyId, { limit, agentId });
    return dbHistory.length > 0 ? dbHistory : heartbeatEngine.getHistory(companyId);
  });

  app.patch("/api/heartbeat/config", async (request, reply) => {
    const parsed = heartbeatConfigPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid config patch",
        details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      };
    }
    heartbeatEngine.patchConfig(parsed.data);
    return { config: heartbeatEngine.getConfig() };
  });
}
