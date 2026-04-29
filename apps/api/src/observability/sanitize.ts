/**
 * Audit C4 (F-429) — error sanitization for public route responses.
 *
 * Background: ~11 public route handlers send `err.message` directly
 * back to the HTTP client. In production that leaks Postgres error
 * strings (table/column names, query fragments), filesystem paths
 * from stack hints, and OpenAI/internal-service URLs. Operators have
 * no correlation id to tie a client report back to a server log.
 *
 * Fix: every error response on the public surface goes through
 * `sanitizeError` which:
 *
 *   - In production: returns a generic operator-supplied message and
 *     a correlation id. The full error (including stack) is emitted
 *     as a typed `error` event via `observability.logEvent`, the
 *     same sink used by the C2 swallow helpers — pino + activity-
 *     log + OTEL + langfuse all see it.
 *
 *   - In dev / non-production: returns the real `err.message` so
 *     debugging stays frictionless. Still emits the error event.
 *
 *   - In all environments: the returned `correlationId` is stable
 *     and round-trippable — the client sees it, the server logged
 *     it under the same id.
 *
 * Why `observability.logEvent` not `auditError`:
 *   The audit ledger is for *business* events the operator/board
 *   needs to see in the company timeline (task lifecycle, policy
 *   violations, board approvals). Route-level operational failures
 *   are infra signals — Postgres unreachable, LLM timeout, schema
 *   parse rejection — and belong on the monitoring/alerting path.
 *   Using the typed error sink keeps a single error pipeline that
 *   already lights up dashboards in production.
 *
 * Internal MCP (`/api/internal/*`) routes are NOT a target — agents
 * consume those, they need the real error to recover. The C4 audit
 * cited the public surface only.
 */
import { randomUUID } from "node:crypto";
import { observability } from "@arceus/contracts";
import type { ArceusEvent } from "@arceus/contracts/src/observability/events.js";

export interface SanitizedError {
  /** Operator-safe message. In prod = the fallback; in dev = err.message. */
  error: string;
  /**
   * Always present so client logs and server logs can be joined. In
   * production this is the only thing that distinguishes one error
   * from another to the client.
   */
  correlationId: string;
}

export interface SanitizeContext {
  /** Route path used to scope the error event (`POST /api/strategy`). */
  route?: string;
  /** Company under which the failure occurred, when known. */
  companyId?: string;
  /** Caller agent role / actor when known. */
  agentRole?: string;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Convert a thrown value into a client-safe response shape and emit
 * a typed `error` event with the unredacted details.
 *
 *   ```ts
 *   try { … }
 *   catch (err) {
 *     reply.code(500);
 *     return sanitizeError(err, "Strategy generation failed.", { route: "POST /api/strategy" });
 *   }
 *   ```
 */
export function sanitizeError(
  err: unknown,
  fallbackMessage: string,
  ctx: SanitizeContext = {},
): SanitizedError {
  const correlationId = randomUUID();
  const realMessage = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  const where = ctx.route ?? "route";
  const detailParts = [
    `correlationId=${correlationId}`,
    ctx.companyId ? `companyId=${ctx.companyId}` : null,
    ctx.agentRole ? `agentRole=${ctx.agentRole}` : null,
  ].filter((p): p is string => p !== null);

  // observability.logEvent never throws (it swallows sink failures
  // internally), so this call is safe inside an error path.
  const event: ArceusEvent = {
    event: "error",
    where,
    message: `${fallbackMessage} | real=${realMessage} | ${detailParts.join(" ")}`,
    ...(stack ? { stack } : {}),
    ts: Date.now(),
  };
  observability.logEvent(event);

  return {
    error: isProduction() ? fallbackMessage : realMessage,
    correlationId,
  };
}
