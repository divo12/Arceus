import type { FastifyReply, FastifyRequest } from "fastify";

type McpHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
import { randomUUID } from "node:crypto";
import { failure, causeToStatus, type ErrorCause } from "./envelope.js";
import { resolveBearerToken } from "../../auth/bearer.js";
import { hashBody, lookupIdempotency, rememberIdempotency, releaseIdempotency, IDEMPOTENCY_FAILURES } from "./idempotency.js";
import { getSessionContext, findActiveSessionContextByRole, findSoleActiveSessionContext, sessionContextSize } from "../../orchestration/session-context.js";
import { pendingPromptCompletions } from "../../orchestration/state.js";
import { observability, parseRoleStrict, type RoleType } from "@arceus/contracts";
import { routeToTool } from "./route-to-tool.js";
import { recordPolicyDeny, type DenyReason } from "../../governance/policy.js";
import { swallowAndAudit } from "../../observability/swallow.js";

interface McpRequestContext {
  companyId: string;
  beatId: string;
  role: string;
  requestId: string;
  idempotencyKey: string | null;
  /** Spec 32 — derived tool name + monotonic invoke timestamp for tool.result correlation. */
  tool?: string;
  invokedAt?: number;
  /** Spec 32 — envelope.error.cause captured at onSend so tool.result reports the
   * real cause (e.g. `task_not_claimable`, `deps_unmet`, `governance`) rather than
   * a lossy HTTP-status fallback (`conflict`, `governance`). */
  failureCause?: string;
  failureStopWhen?: string;
  failureDetails?: Record<string, unknown>;
}

declare module "fastify" {
  interface FastifyRequest {
    mcp?: McpRequestContext;
  }
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_.\-]{8,128}$/;

const getHeader = (req: FastifyRequest, name: string): string | null => {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
};

const respondError = (
  reply: FastifyReply,
  cause: ErrorCause,
  summary: string,
  retry: "safe" | "unsafe" | "never",
  stopWhen: string
): FastifyReply => {
  return reply.code(causeToStatus[cause]).send(failure(summary, cause, retry, stopWhen));
};

export const mcpAuth: McpHook = async (req, reply) => {
  const expected = resolveBearerToken();
  const auth = getHeader(req, "authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token || token !== expected) {
    reply.code(401).send(failure("Invalid or missing bearer token.", "governance", "never", "rotate_token"));
    return reply;
  }
};

export const mcpRequestContext: McpHook = async (req, reply) => {
  const claimedBeatId = getHeader(req, "x-beat-id");
  const claimedCompanyId = getHeader(req, "x-company-id");
  const claimedRole = getHeader(req, "x-agent-role") ?? getHeader(req, "x-role");
  const sessionId = getHeader(req, "x-session-id");

  // Resolve identity from session-context (authoritative) — spec 25 §3.2.
  // Prefer explicit sessionId, then role-based lookup, then sole-active fallback.
  let beatId: string | null = null;
  let companyId: string | null = null;
  let role: string | null = null;

  const ctx = sessionId
    ? getSessionContext(sessionId)
    : claimedRole
      ? findActiveSessionContextByRole(claimedRole)
      : findSoleActiveSessionContext();

  if (ctx) {
    beatId = ctx.beatId;
    companyId = ctx.companyId;
    role = ctx.role;

    // Headers are advisory — if present they must agree with resolved context.
    if (claimedRole && claimedRole !== ctx.role) {
      respondError(reply, "governance", `Identity mismatch: header role "${claimedRole}" differs from session role "${ctx.role}".`, "never", "identity_correct");
      return reply;
    }
    if (claimedBeatId && claimedBeatId !== ctx.beatId) {
      respondError(reply, "governance", `Identity mismatch: header beatId differs from session beatId.`, "never", "identity_correct");
      return reply;
    }
    if (claimedCompanyId && claimedCompanyId !== ctx.companyId) {
      respondError(reply, "governance", `Identity mismatch: header companyId differs from session companyId.`, "never", "identity_correct");
      return reply;
    }
  } else {
    // No session-context found — fall back to headers (migration shim).
    beatId = claimedBeatId;
    companyId = claimedCompanyId;
    role = claimedRole;
  }

  if (!beatId || !companyId || !role) {
    respondError(
      reply,
      "validation",
      `Missing agent identity. Supply X-Session-Id or X-Beat-Id/X-Company-Id/X-Agent-Role headers. Active sessions: ${sessionContextSize()}`,
      "never",
      "headers_fixed"
    );
    return reply;
  }

  const requestId = getHeader(req, "x-request-id") ?? randomUUID();
  const idempotencyKey = getHeader(req, "idempotency-key") ?? undefined;

  if (idempotencyKey && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    respondError(reply, "validation", "Idempotency-Key must be 8-128 chars matching [A-Za-z0-9:_.\\-].", "never", "client_supplies_key");
    return reply;
  }

  req.mcp = { beatId, companyId, role, requestId, idempotencyKey: idempotencyKey ?? null };
  void reply.header("x-request-id", requestId);

  // P0a — Defense in depth for the stall-guard. Tool calls are concrete
  // proof of agent activity; resetting `lastActivityAt` on the HTTP path
  // works regardless of whether OpenCode's SSE stream is alive. The SSE
  // hook in event-bridge.ts:184 stays — both signals reset the same
  // timer. We only have a sessionId to look up if the caller passed one
  // (heartbeat beat tools always do; the chat path uses its own
  // registration so it's already covered there).
  if (sessionId) {
    const pending = pendingPromptCompletions.get(sessionId);
    if (pending) pending.lastActivityAt = Date.now();
  }
};

const RATE_LIMIT = 10_000;

export const mcpRateLimitHeaders: McpHook = async (_req, reply) => {
  void reply.header("x-ratelimit-limit", String(RATE_LIMIT));
  void reply.header("x-ratelimit-remaining", String(RATE_LIMIT));
  void reply.header("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 60));
};

export const mcpIdempotencyReplay: McpHook = async (req, reply) => {
  const mcp = req.mcp;
  if (!mcp?.idempotencyKey || req.method === "GET") return;

  const lookup = await lookupIdempotency(mcp.companyId, mcp.beatId, mcp.idempotencyKey, req.body);
  if (lookup.kind === "miss") return; // we now hold a pending placeholder

  if (lookup.kind === "fail") {
    const spec = IDEMPOTENCY_FAILURES[lookup.reason];
    for (const [name, value] of Object.entries(spec.extraHeaders ?? {})) {
      void reply.header(name, value);
    }
    reply.code(causeToStatus[spec.cause]).send(failure(spec.summary, spec.cause, spec.retry, spec.stopWhen));
    return reply;
  }

  emitIdempotencyReplay(mcp.tool ?? "unknown", mcp.idempotencyKey);
  if (lookup.locationHeader) void reply.header("location", lookup.locationHeader);
  reply.code(lookup.status).send(lookup.body);
  return reply;
};

/**
 * Persist a successful response to the idempotency table so subsequent retries
 * with the same key replay it. Fire-and-forget: the row already exists as a
 * pending placeholder from `mcpIdempotencyReplay`; we're updating it. Errors
 * from the DB write are swallowed (the response has already been sent).
 */
export const cacheSuccessfulResponse = (
  req: FastifyRequest,
  response: { status: number; body: unknown; locationHeader?: string | null }
): void => {
  const mcp = req.mcp;
  if (!mcp?.idempotencyKey || req.method === "GET") return;
  if (response.status >= 400) {
    // Failed handler — drop the pending placeholder so the next retry
    // (same content-addressed key) can try fresh instead of being blocked
    // by `in_flight` for the 5-minute pending TTL.
    swallowAndAudit("idempotency.release_failed", () =>
      releaseIdempotency(mcp.companyId, mcp.beatId, mcp.idempotencyKey!),
    { companyId: mcp.companyId, agentRole: mcp.role, beatId: mcp.beatId, detail: { idempotencyKey: mcp.idempotencyKey, reason: "handler_failed" } });
    return;
  }
  swallowAndAudit("idempotency.remember", () =>
    rememberIdempotency(mcp.companyId, mcp.beatId, mcp.idempotencyKey!, req.body, response),
  { companyId: mcp.companyId, agentRole: mcp.role, beatId: mcp.beatId, detail: { idempotencyKey: mcp.idempotencyKey, status: response.status } });
};

// ── Spec 32 — emit tool.invoked / tool.result / tool.denied ──────────────

/**
 * Internal endpoints that are runtime housekeeping rather than agent "tools".
 * Emitting tool.invoked/tool.result for these would spam the inspector and
 * pollute beat scoring (the watchdog ping fires after every real tool call,
 * so it would double the event volume on its own).
 *
 * Match against the resolved route template, e.g.
 *   "/api/internal/v1/beats/:beatId/watchdog-reset"
 */
const SILENT_ROUTE_URLS = new Set<string>([
  "/api/internal/v1/beats/:beatId/watchdog-reset",
]);

const isSilentRoute = (routeUrl: string): boolean => SILENT_ROUTE_URLS.has(routeUrl);

/**
 * preHandler hook — runs after mcpRequestContext, after Fastify has resolved
 * the route template (so req.routeOptions.url is available). Emits tool.invoked
 * once per MCP request, derives a stable tool name, and stamps both onto
 * `req.mcp` so the onResponse hook can compute duration and emit tool.result.
 *
 * GETs and idempotency replays still emit so the trace shows the cache hit
 * — see mcpEmitIdempotencyReplay below for the replay-specific event.
 */
export const mcpEmitToolInvoked: McpHook = async (req) => {
  const mcp = req.mcp;
  if (!mcp) return;
  const routeUrl = (req.routeOptions as { url?: string } | undefined)?.url ?? req.url;
  if (isSilentRoute(routeUrl)) return;
  const tool = routeToTool(req.method, routeUrl);
  mcp.tool = tool;
  mcp.invokedAt = Date.now();
  // Merge path params into args so URL-template tools (e.g. task_claim,
  // which carries `taskId` only as a path segment) show what the agent
  // actually targeted. Without this the inspector only sees `{ reason }`
  // and we can't tell if the agent hallucinated an id.
  const params = (req.params ?? null) as Record<string, unknown> | null;
  const body = (req.body ?? null) as Record<string, unknown> | null;
  let mergedArgs: unknown = body;
  if (params && Object.keys(params).length > 0) {
    mergedArgs = { ...(body ?? {}), ...params };
  }
  observability.logEvent({
    event: "tool.invoked",
    beatId: mcp.beatId,
    role: parseRoleStrict(mcp.role),
    tool,
    args: mergedArgs,
    idempotencyKey: mcp.idempotencyKey ?? undefined,
    ts: mcp.invokedAt,
  });
};

/**
 * onResponse hook — emits tool.result for every MCP response, success or
 * envelope-failure. The pair (tool.invoked, tool.result) bookends a span
 * in the OTEL sink.
 */
export const mcpEmitToolResult = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const mcp = req.mcp;
  if (!mcp?.tool || mcp.invokedAt == null) return;
  const status = reply.statusCode;
  const ok = status < 400;
  const ts = Date.now();
  const cause = ok ? undefined : (mcp.failureCause ?? causeFromStatus(status));
  observability.logEvent({
    event: "tool.result",
    beatId: mcp.beatId,
    tool: mcp.tool,
    ok,
    cause,
    details: ok ? undefined : mcp.failureDetails,
    durationMs: ts - mcp.invokedAt,
    ts,
  });

  // Spec 31 Phase 5 — policy_violations DB mirror. Only the typed
  // ErrorCauses listed in CAUSE_TO_DENY_REASON map to a denial; everything
  // else (validation, conflict, upstream, …) is a regular error and is
  // already covered by tool.result. Recording is best-effort telemetry.
  if (!ok && typeof cause === "string" && mcp.tool) {
    const reason = CAUSE_TO_DENY_REASON[cause as ErrorCause];
    if (reason) {
      const toolName = mcp.tool;
      swallowAndAudit("policy.deny.record", () => recordPolicyDeny({
        companyId: mcp.companyId,
        role: mcp.role,
        tool: toolName,
        reason,
        detail: cause,
      }), { companyId: mcp.companyId, agentRole: mcp.role, beatId: mcp.beatId, detail: { tool: toolName, reason, cause } });
    }
  }
};

/**
 * Typed mapping from envelope ErrorCause → DenyReason. Only the 403-class
 * causes are listed; all others map to `undefined` and are skipped. Adding
 * a new deny-class cause to envelope.ts and this table is a one-line edit
 * — no `cause === "..."` checks scattered across handlers.
 */
const CAUSE_TO_DENY_REASON: Partial<Record<ErrorCause, DenyReason>> = {
  governance: "governance_block",
  identity_mismatch: "role_gate",
};

/**
 * onSend hook — peeks at the outgoing payload to capture the envelope's
 * `error.cause` and `error.stopWhen` onto `req.mcp` before mcpEmitToolResult
 * runs in onResponse. Without this, every 409 collapses to `"conflict"` and
 * loses the distinction between `already_claimed`, `not_claimable`,
 * `deps_unmet`, etc.
 */
export const mcpCapturePayloadCause = async (
  req: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> => {
  const mcp = req.mcp;
  if (!mcp || reply.statusCode < 400) return payload;
  try {
    const obj: unknown = typeof payload === "string" ? JSON.parse(payload) : payload;
    const err = (obj as { error?: { cause?: string; stopWhen?: string; details?: Record<string, unknown> } } | null)?.error;
    if (err?.cause) mcp.failureCause = err.cause;
    if (err?.stopWhen) mcp.failureStopWhen = err.stopWhen;
    if (err?.details && typeof err.details === "object") mcp.failureDetails = err.details;
  } catch {
    // Payload not JSON or not an envelope — fall back to status mapping.
  }
  return payload;
};

/** Best-effort mapping from HTTP status back to envelope cause for tool.result. */
function causeFromStatus(status: number): string | undefined {
  if (status === 401) return "auth_invalid";
  if (status === 403) return "governance";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status >= 500) return "internal";
  if (status >= 400) return "request_error";
  return undefined;
}

/**
 * Emit `idempotency.replay` when mcpIdempotencyReplay short-circuits a request.
 * Called by the early-return path in mcpIdempotencyReplay below.
 */
function emitIdempotencyReplay(tool: string, key: string): void {
  observability.logEvent({
    event: "idempotency.replay",
    tool,
    key,
    ts: Date.now(),
  });
}
