import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cpGetBeatHistory } from "../../persistence/control-plane/index.js";
import { recordBeatActivity } from "../../heartbeats/watchdog.js";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { success, failure } from "./envelope.js";
import { bumpBeatToolCallAccumulator } from "../../infra/azure-openai.js";
import { pendingPromptCompletions } from "../../orchestration/state.js";
import { observability, parseRoleStrict } from "@arceus/contracts";

const BEATS_BASE = "/api/internal/v1/beats";

export default async function internalMcpBeatsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/internal/v1/beats/recent
   *
   * Returns the last N beat progress notes for the calling role.
   * Query params:
   *   n — number of beats to return (1–10, default 3)
   *
   * Role + companyId resolved from session context by middleware.
   */
  app.get(`${BEATS_BASE}/recent`, async (req: FastifyRequest, reply: FastifyReply) => {
    const { role, companyId } = req.mcp ?? {};
    if (!role || !companyId) {
      return reply.code(400).send(failure("Missing role or companyId in request context.", "session_required", "never", "session_provided"));
    }

    const query = (req.query ?? {}) as Record<string, string>;
    const n = Math.min(Math.max(parseInt(query.n ?? "3", 10) || 3, 1), 10);

    // Spec 31 Phase 7.B.5 — read agent from canonical via repo, not snapshot.
    const agent = await agentsRepo.findAgentByRole(getDb(), companyId, role);
    if (!agent) {
      return reply.code(404).send(failure(`No agent found for role "${role}".`, "not_found", "never", "agent_exists"));
    }

    const beats = await cpGetBeatHistory(companyId, { agentId: agent.id, limit: n });

    const progressNotes = beats.map((beat) => ({
      beatId: beat.id,
      beatNumber: beat.beatNumber,
      status: beat.status,
      outcome: beat.outcome,
      summary: beat.summary,
      startedAt: beat.startedAt,
      endedAt: beat.endedAt,
      totalTokens: beat.totalTokens,
    }));

    return reply.code(200).send(success(`Last ${progressNotes.length} beat(s) for ${role}.`, { notes: progressNotes }));
  });

  /**
   * POST /api/internal/v1/beats/:beatId/watchdog-reset
   *
   * Bumps the in-memory `lastActivityAt` timestamp for a beat. Called by the
   * OpenCode plugin's PostToolUse hook so multi-tool beats don't trip the
   * watchdog while making genuine forward progress. Fire-and-forget from the
   * caller's perspective — returns a tiny envelope and never errors on a
   * missing beat.
   *
   * When the request body carries `{ tool, status, cause?, latencyMs?, role?,
   * sessionId? }`, the endpoint also:
   *   • Emits `tool.invoked` + `tool.result` observability events so built-in
   *     OpenCode tools (read, bash, edit, skill, …) land in `activity_log`
   *     alongside arceus_* MCP tools — same shape as the MCP middleware
   *     emits, so downstream queries don't need to special-case the source.
   *   • Bumps the per-beat tool-call accumulator (drained by runBeat into
   *     `heartbeat_runs.tool_call_count`).
   *   • Bumps `pending.toolCallCount` on the resolved session so the
   *     no_tool_invoked early-exit deadline correctly sees built-in activity
   *     and stops killing developer beats at 90s.
   *
   * Bodyless calls retain the historical watchdog-only semantics — the
   * plugin uses that path for arceus_* tools (already logged by MCP
   * middleware) to avoid double-counting.
   */
  app.post<{
    Params: { beatId: string };
    Body?: {
      tool?: string;
      status?: "ok" | "error";
      cause?: string;
      latencyMs?: number;
      role?: string;
      sessionId?: string;
      args?: unknown;
    };
  }>(
    `${BEATS_BASE}/:beatId/watchdog-reset`,
    async (req, reply) => {
      const { beatId } = req.params;
      if (!beatId) {
        return reply.code(400).send(failure("beatId is required.", "validation", "never", "payload_fixed"));
      }
      const ts = recordBeatActivity(beatId);

      // Body is optional — bodyless calls preserve the watchdog-only
      // contract used by the plugin for arceus_* tools.
      const body = (req.body ?? {});

      if (typeof body.tool === "string" && body.tool.length > 0) {
        const tool = body.tool;
        const ok = body.status !== "error";
        const role = typeof body.role === "string" && body.role.length > 0
          ? body.role
          : null;

        // Mirror the per-beat tool counter so heartbeat_runs.tool_call_count
        // includes built-ins. arceus_* tools are bumped from the MCP
        // middleware; the plugin only POSTs a body for non-arceus tools, so
        // there's no double-counting here.
        bumpBeatToolCallAccumulator(beatId);

        // Mirror the no_tool_invoked deadline counter so a developer reading
        // 5 files via built-in `read` for 90s isn't reaped as "thinking but
        // not acting." Resolved via sessionId if the plugin sent one.
        if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
          const pending = pendingPromptCompletions.get(body.sessionId);
          if (pending) {
            pending.lastActivityAt = Date.now();
            pending.toolCallCount += 1;
          }
        }

        // Same event shape as MCP middleware emits, so anyone querying
        // activity_log for `tool.invoked`/`tool.result` sees built-ins
        // without having to filter by tool prefix. `tool.invoked` requires
        // a typed role; if the plugin couldn't resolve one we skip the
        // invoked emit but still emit `tool.result` so latency telemetry
        // isn't lost.
        try {
          const parsedRole = role ? parseRoleStrict(role) : null;
          if (parsedRole) {
            observability.logEvent({
              event: "tool.invoked",
              beatId,
              role: parsedRole,
              tool,
              args: body.args ?? null,
              ts: Date.now(),
            });
          }
          observability.logEvent({
            event: "tool.result",
            beatId,
            tool,
            ok,
            ...(body.cause ? { cause: body.cause } : {}),
            durationMs: typeof body.latencyMs === "number" ? body.latencyMs : 0,
            ts: Date.now(),
          });
        } catch {
          // observability emit failures are non-fatal — never reject a
          // best-effort plugin POST because logging fanned out badly.
        }
      }

      return reply.code(200).send(success("Watchdog reset.", {
        beatId,
        lastActivityAt: new Date(ts).toISOString(),
      }));
    },
  );
}
