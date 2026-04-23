import type { FastifyReply, FastifyRequest } from "fastify";

type McpHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
import { randomUUID } from "node:crypto";
import { failure, causeToStatus, type ErrorCause } from "./envelope.js";
import { resolveBearerToken } from "../../auth/bearer.js";
import { hashBody, lookupIdempotency, rememberIdempotency } from "./idempotency.js";
import { getSessionContext, findActiveSessionContextByRole, findSoleActiveSessionContext, sessionContextSize } from "../../orchestration/session-context.js";

export interface McpRequestContext {
  companyId: string;
  beatId: string;
  role: string;
  requestId: string;
  idempotencyKey: string | null;
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

  const lookup = lookupIdempotency(mcp.companyId, mcp.beatId, mcp.idempotencyKey, req.body);
  if (lookup.kind === "miss") return;

  if (lookup.kind === "conflict") {
    reply.code(409).send(failure(
      "Idempotency-Key replayed with a different body.",
      "conflict",
      "never",
      "generate_new_key"
    ));
    return reply;
  }

  if (lookup.locationHeader) void reply.header("location", lookup.locationHeader);
  reply.code(lookup.status).send(lookup.body);
  return reply;
};

export const cacheSuccessfulResponse = (
  req: FastifyRequest,
  response: { status: number; body: unknown; locationHeader?: string | null }
): void => {
  const mcp = req.mcp;
  if (!mcp?.idempotencyKey || req.method === "GET") return;
  if (response.status >= 400) return;
  rememberIdempotency(mcp.companyId, mcp.beatId, mcp.idempotencyKey, req.body, response);
};

export { hashBody };
