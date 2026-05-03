/**
 * Spec 32 / Audit C2 (silent error swallowing) — package-level swallow
 * helper for any runtime package.
 *
 * `apps/api` has its own richer `swallowAndAudit` (in
 * `apps/api/src/observability/swallow.ts`) that funnels through the
 * audit ledger. Runtime packages can't import from there — apps/api
 * depends on them, not the reverse — so we provide a minimal helper
 * that routes failures through the contracts-level `observability.logEvent`
 * sink.
 *
 * The shape mirrors `swallowAndAudit`: `where` is the call-site key,
 * `fn` is a Promise factory, and `ctx` carries optional companyId /
 * beatId / detail. On caught failure we emit a typed `error` event so
 * pino + activity-log + OTEL all see it.
 */
import { observability, type ArceusEvent } from "@arceus/contracts";

interface SwallowContext {
  companyId?: string;
  beatId?: string;
  detail?: Record<string, unknown>;
}

function emitErrorEvent(where: string, err: unknown, ctx: SwallowContext): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // Build the error variant. `Extract` of a Zod-inferred discriminated
  // union doesn't always narrow cleanly through the inferred shape, so
  // we widen via the union itself — the explicit `event: "error"`
  // discriminator picks the right schema branch at the sink.
  const errorEvent = {
    event: "error" as const,
    where,
    message: ctx.detail ? `${message} | ctx=${JSON.stringify(ctx.detail)}` : message,
    ...(stack ? { stack } : {}),
    ...(ctx.beatId ? { beatId: ctx.beatId } : {}),
    ts: Date.now(),
  } satisfies Pick<Extract<ArceusEvent, { event: "error" }>, "event" | "where" | "message" | "ts">;
  observability.logEvent(errorEvent);
}

/**
 * Fire-and-forget wrapper. Returns `void`. The caller MUST NOT depend
 * on the result. On failure, emits a typed `error` event and resolves
 * silently.
 */
export function swallowAndAudit<T>(
  where: string,
  fn: () => Promise<T>,
  ctx: SwallowContext = {},
): void {
  void fn().catch((err: unknown) => {
    emitErrorEvent(where, err, ctx);
  });
}
