/**
 * Silent-error rescue — Spec 32 + C2 audit.
 *
 * Replaces every `.catch(() => {})` / `.catch(console.warn)` /
 * empty-catch in the runtime with a wrapper that funnels the failure
 * through `observability.logEvent({ event: "error" })`.
 *
 * Why this matters
 * ────────────────
 * Bare `.catch(() => {})` is the quietest bug class in the codebase:
 * a transient DB / network / LLM failure disappears, the audit ledger
 * stays clean, the inspector shows nothing, and the operator is left
 * with "the dashboard looks fine but state diverged". The C2 audit
 * counted ~32 production sites where this happens; this helper is the
 * canonical fix.
 *
 * Routing
 * ───────
 * Lands in every observability sink wired in `server.ts`:
 *   - `eventBusSink` → in-memory ring buffer (live `/inspector` SSE)
 *   - `activityLogSink` → durable `activity_log` table row
 *   - `pinoSink` → structured stdout
 *   - `otelSink` → OTel span event
 *
 * Use this — NOT `audit()` — for swallowed RUNTIME errors. `audit()` is
 * for governance "who-did-what" trails (different SSE channel, different
 * mental model). The `event: "error"` variant is the typed shape for
 * error-class events; that's where this belongs.
 *
 * Signature
 * ─────────
 * `swallowAndAudit(where, fn, ctx?)` — fire-and-forget.
 * `swallowAndReport(where, fn, ctx?)` — same surface but `await`able and
 *     returns the resolved value (or `undefined` on failure). Use when
 *     the calling code needs to decide based on success/failure.
 *
 * Identifying conventions
 * ───────────────────────
 *   - `where` is a stable dot-notation key (`trust.update.pass`,
 *     `ata.pipeline`, `idempotency.release`, ...) so the inspector can
 *     filter and group. Keep it stable across refactors.
 *   - `ctx.companyId` / `ctx.agentRole` / `ctx.beatId` add structured
 *     context. They're encoded into the `message` string today because
 *     `errorSchema` (in @arceus/contracts) is lean; if we add typed
 *     fields later, consumers won't need to re-parse.
 *
 * Anti-patterns this replaces
 * ───────────────────────────
 *   - `void asyncFn().catch(() => {})`
 *   - `asyncFn().catch(err => console.warn(err.message))`
 *   - `try { await asyncFn(); } catch (silent) { ... }`
 *
 *   ✓ `swallowAndAudit("xyz.something", () => asyncFn(), ctx)`
 *
 * The ESLint rule in `.eslintrc.cjs` (`no-silent-catch`) enforces this.
 */
import { observability } from "@arceus/contracts";

export interface SwallowContext {
  /** Friendly company id when known. Defaults to `_system`. */
  companyId?: string;
  /** Agent role on whose behalf the call ran (`developer`, `ceo`, …). */
  agentRole?: string;
  /** Friendly beat id when the call belongs to a heartbeat. */
  beatId?: string;
  /**
   * Extra structured context the operator will want when triaging.
   * Inlined into the `message` string today; will become a first-class
   * field if `errorSchema` gains a `detail` slot.
   */
  detail?: Record<string, unknown>;
}

function formatMessage(err: unknown, ctx: SwallowContext): string {
  const base = err instanceof Error ? err.message : String(err);
  const tag = `[${ctx.agentRole ?? "system"}/${ctx.companyId ?? "_system"}]`;
  if (ctx.detail && Object.keys(ctx.detail).length > 0) {
    let detailStr: string;
    try {
      detailStr = JSON.stringify(ctx.detail);
    } catch {
      // Circular ref or BigInt — best-effort fallback so the inspector
      // still gets *something*. The error event itself must never throw.
      detailStr = String(ctx.detail);
    }
    return `${tag} ${base} :: ${detailStr}`;
  }
  return `${tag} ${base}`;
}

function emitError(where: string, err: unknown, ctx: SwallowContext): void {
  observability.logEvent({
    event: "error",
    where: `swallow.${where}`,
    message: formatMessage(err, ctx),
    stack: err instanceof Error && err.stack ? err.stack : undefined,
    beatId: ctx.beatId,
    ts: Date.now(),
  });
}

/**
 * Fire-and-forget wrapper. Returns `void`. The caller must NOT depend
 * on the result. On failure, emits an `error` event to all sinks and
 * resolves silently.
 */
export function swallowAndAudit<T>(
  where: string,
  fn: () => Promise<T>,
  ctx: SwallowContext = {},
): void {
  void fn().catch((err: unknown) => {
    emitError(where, err, ctx);
  });
}

/**
 * Awaitable variant. Returns the resolved value on success, `undefined`
 * on failure (after emitting). Use when the caller needs to gate
 * downstream logic on the outcome (e.g. "skip the next step if this
 * failed") — but still wants the failure surfaced to operators.
 */
export async function swallowAndReport<T>(
  where: string,
  fn: () => Promise<T>,
  ctx: SwallowContext = {},
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    emitError(where, err, ctx);
    return undefined;
  }
}
