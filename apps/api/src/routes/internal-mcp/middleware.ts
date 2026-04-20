import type { FastifyReply, FastifyRequest } from "fastify";

type McpHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
import { randomUUID } from "node:crypto";
import { failure, causeToStatus, type ErrorCause } from "./envelope.js";
import { hashBody, lookupIdempotency, rememberIdempotency } from "./idempotency.js";

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

const UUID_RE = /^[0-9a-fA-F-]{8,}$/;

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
  const expected = process.env.ARCEUS_INTERNAL_TOKEN ?? process.env.ARCEUS_TOKEN;
  const auth = getHeader(req, "authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!expected) {
    respondError(reply, "internal", "Server missing ARCEUS_INTERNAL_TOKEN configuration.", "never", "server_configured");
    return reply;
  }
  if (!token || token !== expected) {
    reply.code(401).send(failure("Invalid or missing bearer token.", "governance", "never", "rotate_token"));
    return reply;
  }
};

export const mcpRequestContext: McpHook = async (req, reply) => {
  const beatId = getHeader(req, "x-beat-id");
  const companyId = getHeader(req, "x-company-id");
  const role = getHeader(req, "x-agent-role") ?? getHeader(req, "x-role");

  if (!beatId || !companyId || !role) {
    respondError(
      reply,
      "validation",
      "Missing required headers (X-Beat-Id, X-Company-Id, X-Agent-Role).",
      "never",
      "headers_fixed"
    );
    return reply;
  }

  const requestId = getHeader(req, "x-request-id") ?? randomUUID();
  const idempotencyKey = getHeader(req, "idempotency-key");

  if (req.method !== "GET" && !idempotencyKey) {
    respondError(reply, "validation", "Idempotency-Key header required on non-GET requests.", "never", "client_supplies_key");
    return reply;
  }

  if (idempotencyKey && !UUID_RE.test(idempotencyKey)) {
    respondError(reply, "validation", "Idempotency-Key must be a UUID or opaque token.", "never", "client_supplies_key");
    return reply;
  }

  req.mcp = { beatId, companyId, role, requestId, idempotencyKey };
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
