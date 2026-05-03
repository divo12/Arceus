/**
 * Internal telemetry routes — plugin/orchestrator callbacks, NOT agent-invoked.
 *
 * These routes are called by the OpenCode plugin (skill-usage) and the Arceus
 * orchestrator (future: additional bookkeeping), never by agents via the MCP
 * tool surface. They require bearer auth (same secret as MCP) but skip the
 * MCP idempotency-replay / per-beat context middleware because:
 *
 *   - They're fire-and-forget. Repeated POSTs simply re-record; there's no
 *     agent-intent to replay.
 *   - They're not bound to an in-flight tool call, so per-beat context from
 *     `x-beat-id` headers is optional (supplied in the body instead).
 *
 * Mounted under `/api/internal/telemetry/*` so the `/api/internal/v1/*`
 * preHandler in `internal-mcp/index.ts` does not intercept them.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import { getSkillById, recordSkillUsage } from "@arceus/company-runtime";
import { failure, success, type ErrorCause } from "./internal-mcp/envelope.js";
import { mcpAuth } from "./internal-mcp/middleware.js";
import { getSessionContext } from "../orchestration/session-context.js";

const TELEMETRY_BASE = "/api/internal/telemetry";

// ── Per-beat usage tally (in-memory) ─────────────────────
//
// Tracks which skillIds were invoked during each beat so the orchestrator can
// call `updateSuccessRate(skillId, outcome)` for every used skill when the
// beat verdict arrives (Phase 6.5 package K).
//
// Bounded to prevent unbounded growth if `clearBeatSkillUsage` is skipped
// (e.g. crashed orchestrator, forgotten finalizer):
//   - TTL: entries older than BEAT_SKILL_TTL_MS are dropped on access / insert.
//   - Hard cap: MAX_BEATS oldest entries evicted when exceeded.

interface BeatSkillEntry {
  skills: Set<string>;
  createdAt: number;
}

const BEAT_SKILL_TTL_MS = 60 * 60 * 1000; // 1 hour — 4x beat hard cap
const MAX_BEATS = 5_000;

const beatSkillSets = new Map<string, BeatSkillEntry>();

function gcExpired(now: number): void {
  for (const [key, entry] of beatSkillSets) {
    if (now - entry.createdAt > BEAT_SKILL_TTL_MS) {
      beatSkillSets.delete(key);
    }
  }
  if (beatSkillSets.size > MAX_BEATS) {
    // Map preserves insertion order — evict oldest first.
    const overflow = beatSkillSets.size - MAX_BEATS;
    let dropped = 0;
    for (const key of beatSkillSets.keys()) {
      beatSkillSets.delete(key);
      if (++dropped >= overflow) break;
    }
  }
}

export function recordBeatSkillUsage(beatId: string, skillId: string): void {
  const now = Date.now();
  let entry = beatSkillSets.get(beatId);
  if (!entry || now - entry.createdAt > BEAT_SKILL_TTL_MS) {
    entry = { skills: new Set(), createdAt: now };
    beatSkillSets.set(beatId, entry);
    gcExpired(now);
  }
  entry.skills.add(skillId);
}

export function getBeatSkillUsage(beatId: string): string[] {
  const entry = beatSkillSets.get(beatId);
  if (!entry) return [];
  if (Date.now() - entry.createdAt > BEAT_SKILL_TTL_MS) {
    beatSkillSets.delete(beatId);
    return [];
  }
  return [...entry.skills];
}

export function clearBeatSkillUsage(beatId: string): void {
  beatSkillSets.delete(beatId);
}

/** Test-only: reset the tally map. */
export function __resetBeatSkillUsageForTest(): void {
  beatSkillSets.clear();
}

// ── Validation helpers ───────────────────────────────────

const sendValidation = (reply: FastifyReply, err: ZodError): FastifyReply => {
  return reply.code(422).send({
    ...failure("Request validation failed.", "validation", "never", "payload_fixed"),
    error: {
      cause: "validation" as ErrorCause,
      retry: "never" as const,
      stopWhen: "payload_fixed",
      details: err.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    },
  });
};

const parseOrFail = <T>(schema: ZodSchema<T>, body: unknown, reply: FastifyReply): T | null => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidation(reply, parsed.error);
    return null;
  }
  return parsed.data;
};

const usageBodySchema = z.object({
  beatId: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
});

// ── Routes ───────────────────────────────────────────────

export default async function internalTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith(`${TELEMETRY_BASE}/`)) return;
    await mcpAuth(req, reply);
  });

  /**
   * POST /api/internal/telemetry/skills/:skillId/usage
   *
   * Called by the OpenCode plugin's `tool.execute.after` hook whenever the
   * agent invokes the built-in `skill` tool. Fire-and-forget — repeated calls
   * for the same skill in the same beat simply re-add to the per-beat Set.
   *
   * Body: `{ beatId: string, version?: number }`
   */
  app.post(`${TELEMETRY_BASE}/skills/:skillId/usage`, async (req, reply) => {
    const params = z.object({ skillId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      return sendValidation(reply, params.error);
      return;
    }
    const body = parseOrFail(usageBodySchema, req.body, reply);
    if (!body) return reply;

    const artifact = getSkillById(params.data.skillId);
    if (!artifact) {
      return reply.code(404).send(
        failure(
          `Skill ${params.data.skillId} not found.`,
          "not_found",
          "never",
          "skill_re_materialized",
        ),
      );
      return;
    }

    recordSkillUsage(params.data.skillId);
    recordBeatSkillUsage(body.beatId, params.data.skillId);

    return reply.code(202).send(
      success(`Recorded usage for skill ${artifact.name}.`, {
        skillId: artifact.id,
        name: artifact.name,
        usageCount: artifact.usageCount + 1,
      }),
    );
  });

  /**
   * GET /api/internal/telemetry/session-context/:sessionId
   *
   * Called by the OpenCode plugin and MCP server to resolve beat metadata
   * (allowedTools, beatId, role, companyId) for a given session. Returns 404
   * after the beat ends and the context is unregistered.
   */
  app.get(`${TELEMETRY_BASE}/session-context/:sessionId`, async (req, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      return sendValidation(reply, params.error);
      return;
    }

    const ctx = getSessionContext(params.data.sessionId);
    if (!ctx) {
      return reply.code(404).send(
        failure(
          `No context for session ${params.data.sessionId}.`,
          "not_found",
          "never",
          "session ended",
        ),
      );
      return;
    }

    return reply.code(200).send(ctx);
  });
}
