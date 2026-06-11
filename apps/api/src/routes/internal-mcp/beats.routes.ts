import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cpGetBeatHistory } from "../../persistence/control-plane/index.js";
import { recordBeatActivity, getBeatActivity } from "../../heartbeats/watchdog.js";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { success, failure } from "./envelope.js";
import { bumpBeatToolCallAccumulator } from "../../infra/azure-openai.js";
import { pendingPromptCompletions } from "../../orchestration/state.js";
import { observability, parseRoleStrict } from "@arceus/contracts";

const BEATS_BASE = "/api/internal/v1/beats";

/**
 * Built-in OpenCode tools that count as PRODUCTIVE actions for the
 * no-productive-action watchdog (mirrors ACTION_TOOLS_RESETTING_READ_LOOP
 * for arceus_* tools in middleware.ts).
 *
 * Includes ALL built-in tools the model has access to. Rationale: the
 * read-vs-mutate distinction was too aggressive — developers and UI
 * designers were getting reaped while doing legitimate file inspection.
 * Reading 5 files to understand the codebase before writing code is
 * productive work. Any tool call is evidence the model is engaged
 * with the workspace; only TRUE silence (no tools fired at all) should
 * count as "not productive." That's already covered by
 * NO_TOOL_INVOKED_DEADLINE_MS.
 *
 * So this set is effectively "is the model emitting tool calls at all" —
 * the same as the general activity check. Keep it as a positive list
 * (rather than removing the productive watchdog entirely) so we can
 * tighten specific tools back to "not productive" if we observe a real
 * pathology.
 */
const BUILTIN_PRODUCTIVE_TOOLS = new Set<string>([
  // Mutation
  "edit",
  "write",
  "multiedit",
  "apply_patch",
  // Shell
  "bash",
  // Inspection (still counts — reading is part of the work)
  "read",
  "grep",
  "glob",
  "list",
  "ls",
  // Meta
  "skill",
  "tool_help",
  "webfetch",
]);

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
      // Body is optional — bodyless calls preserve the watchdog-only
      // contract used by the plugin for arceus_* tools.
      const body = (req.body ?? {});

      // Record activity with tool/role context so the live-status endpoint
      // can answer "what is this beat currently doing?"
      const ts = recordBeatActivity(
        beatId,
        typeof body.tool === "string" && body.tool.length > 0 ? body.tool : undefined,
        typeof body.role === "string" && body.role.length > 0 ? body.role : undefined,
      );

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
        // Also bumps `readsSinceAction` on `read` so the poller can detect
        // the gpt-5.4-mini line-by-line read-loop pathology and reject
        // before HARD_CAP_MS (see READ_LOOP_THRESHOLD in prompts/llm.ts).
        if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
          const pending = pendingPromptCompletions.get(body.sessionId);
          if (pending) {
            pending.lastActivityAt = Date.now();
            pending.lastToolAt = Date.now();
            pending.toolCallCount += 1;
            if (tool === "read") pending.readsSinceAction += 1;
            // Built-in mutating tools count as productive actions. Mirrors
            // ACTION_TOOLS_RESETTING_READ_LOOP for arceus_* tools above:
            // when the agent actually writes/edits/commits, reset both
            // the read-loop counter AND the productive-action clock.
            // Without this, a UI designer that does apply_patch successfully
            // then plans the next steps gets reaped at 2-3min for
            // "no productive action" — even though the patch was the
            // most productive thing it could do.
            if (BUILTIN_PRODUCTIVE_TOOLS.has(tool)) {
              pending.readsSinceAction = 0;
              pending.lastProductiveActionAt = Date.now();
            }
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

  /**
   * GET /api/internal/v1/beats/:beatId/status
   *
   * Live "is this beat thinking or stalled?" probe. Reads the in-memory
   * watchdog tracker and classifies the beat into a phase based on
   * seconds since the last tool call:
   *   • active      — tool fired in the last 30s; model is interleaving
   *                   tool calls, productive
   *   • idle_short  — 30–90s; one long thought turn, normal for design
   *                   work + complex reasoning
   *   • idle_long   — 90s–10min; past the no_tool_invoked deadline
   *                   guard but stall poller hasn't killed yet — suspect
   *   • stalled     — 10min+; the next stall-poller tick will reject
   *   • unknown     — beat id not in the tracker (already finished or
   *                   never started)
   *
   * Polled by the inspector to render a live status pill on the active
   * beat row, so operators can tell "model is thinking" from "model is
   * dead" without waiting for the 10-min stall guard.
   */
  app.get<{ Params: { beatId: string } }>(
    `${BEATS_BASE}/:beatId/status`,
    async (req, reply) => {
      const { beatId } = req.params;
      if (!beatId) {
        return reply.code(400).send(failure("beatId is required.", "validation", "never", "payload_fixed"));
      }

      const activity = getBeatActivity(beatId);
      if (!activity) {
        return reply.code(200).send(success("Beat not in active tracker.", {
          beatId,
          phase: "unknown" as const,
          lastActivityAt: null,
          lastTool: null,
          role: null,
          secondsSinceActivity: null,
          secondsRunning: null,
        }));
      }

      const now = Date.now();
      const secondsSinceActivity = Math.floor((now - activity.lastActivityAt) / 1000);
      const secondsRunning = Math.floor((now - activity.startedAt) / 1000);
      const phase: "active" | "idle_short" | "idle_long" | "stalled" =
        secondsSinceActivity < 30
          ? "active"
          : secondsSinceActivity < 90
          ? "idle_short"
          : secondsSinceActivity < 600
          ? "idle_long"
          : "stalled";

      return reply.code(200).send(success("Beat status.", {
        beatId,
        phase,
        lastActivityAt: new Date(activity.lastActivityAt).toISOString(),
        lastTool: activity.lastTool,
        role: activity.role,
        secondsSinceActivity,
        secondsRunning,
      }));
    },
  );
}
