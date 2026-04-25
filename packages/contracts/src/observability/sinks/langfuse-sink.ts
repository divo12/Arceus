/**
 * Langfuse-native sink — bypasses OTLP/HTTP and uses Langfuse's first-party
 * SDK so traces land in their v3 ClickHouse-backed UI.
 *
 * Why this exists: as of 2026-04, Langfuse Cloud's "Faster Langfuse experience"
 * preview UI ingests via a different path than OTLP/HTTP. OTEL spans land in
 * the legacy Postgres store (queryable by API but not visible in the new UI).
 * The native SDK writes directly into the v3 ingestion pipeline, so the new
 * UI sees traces immediately.
 *
 * Trade-off: this couples us to Langfuse for whatever events flow through it.
 * Used as a SECOND sink alongside otelSink — OTEL portability is preserved.
 *
 * Span topology (mirrors otel-sink for consistency):
 *   beat.started      → trace.create({ id: beatId, name: 'beat:{role}' })
 *   beat.completed    → trace.update({ output: { verdict, score, durationMs } })
 *   tool.invoked      → trace.span({ name: 'tool:{tool}', input: args })
 *   tool.result       → span.end({ output: { ok, cause } })
 *   role.handoff,
 *   permission.*,
 *   memory.*, etc.    → trace.event({ name: e.event, metadata: e })
 *   error             → trace.event({ level: 'ERROR', ... }) or standalone trace
 *
 * Tools are sequential within a beat → per-beat stack matches otel-sink.
 */
import type { EventSink } from "../emitter.js";
import type { ArceusEvent } from "../events.js";
import { Langfuse, type LangfuseTraceClient, type LangfuseSpanClient } from "langfuse";

let client: Langfuse | null = null;

const beatTraces = new Map<string, LangfuseTraceClient>();
const toolStacks = new Map<string, LangfuseSpanClient[]>();

export interface LangfuseSinkOptions {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  /** Override flushAt for batching. Default 1 = flush per event (lowest latency). */
  flushAt?: number;
}

function ensureClient(opts: LangfuseSinkOptions): Langfuse | null {
  if (client) return client;
  const publicKey = opts.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = opts.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = opts.baseUrl ?? process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) {
    // eslint-disable-next-line no-console
    console.warn("[langfuseSink] Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL — sink disabled.");
    return null;
  }
  client = new Langfuse({ publicKey, secretKey, baseUrl, flushAt: opts.flushAt ?? 1 });
  return client;
}

function activeTrace(beatId: string | undefined): LangfuseTraceClient | undefined {
  return beatId ? beatTraces.get(beatId) : undefined;
}

export function langfuseSink(opts: LangfuseSinkOptions = {}): EventSink {
  return {
    write(e: ArceusEvent): void {
      const lf = ensureClient(opts);
      if (!lf) return;

      switch (e.event) {
        case "beat.started": {
          const trace = lf.trace({
            id: e.beatId,
            name: `beat:${e.role}`,
            sessionId: e.companyId,
            timestamp: new Date(e.ts),
            input: { role: e.role, sprintId: e.sprintId, trustBand: e.trustBand },
            metadata: {
              companyId: e.companyId,
              sprintId: e.sprintId,
              trustBand: e.trustBand,
              "arceus.beat.id": e.beatId,
            },
            tags: ["beat", e.role],
          });
          // Langfuse v3 UI rejects traces with zero observations as "not found".
          // Create a beat.started event so the trace is always non-empty even
          // when the beat does no tool work (e.g. CEO bootstrap beats).
          trace.event({
            name: "beat.started",
            startTime: new Date(e.ts),
            metadata: {
              role: e.role,
              sprintId: e.sprintId,
              trustBand: e.trustBand,
              companyId: e.companyId,
            },
          });
          beatTraces.set(e.beatId, trace);
          toolStacks.set(e.beatId, []);
          return;
        }

        case "beat.completed": {
          const trace = beatTraces.get(e.beatId);
          if (!trace) return;
          // Close any unfinished tool spans defensively.
          const stack = toolStacks.get(e.beatId) ?? [];
          while (stack.length > 0) {
            const orphan = stack.pop()!;
            orphan.end({ level: "ERROR", statusMessage: "tool span unclosed at beat end" });
          }
          trace.update({
            output: {
              outcome: e.verdictOutcome,
              score: e.verdictScore,
              durationMs: e.durationMs,
            },
          });
          // Mirror beat.started: emit a closing event so the trace's observation
          // list always reflects the lifecycle, not just internal state.
          trace.event({
            name: "beat.completed",
            startTime: new Date(e.ts),
            level: e.verdictOutcome === "fail" ? "ERROR" : "DEFAULT",
            metadata: {
              role: e.role,
              outcome: e.verdictOutcome,
              score: e.verdictScore,
              durationMs: e.durationMs,
            },
          });
          beatTraces.delete(e.beatId);
          toolStacks.delete(e.beatId);
          return;
        }

        case "beat.idle": {
          activeTrace(e.beatId)?.event({ name: "beat.idle", metadata: { stalledMs: e.stalledMs } });
          return;
        }

        case "role.handoff": {
          activeTrace(e.beatId)?.event({
            name: "role.handoff",
            metadata: { from: e.from, to: e.to, reason: e.reason },
          });
          return;
        }

        case "tool.invoked": {
          const trace = beatTraces.get(e.beatId);
          if (!trace) return;
          const span = trace.span({
            name: `tool:${e.tool}`,
            input: e.args,
            startTime: new Date(e.ts),
            metadata: { role: e.role, idempotencyKey: e.idempotencyKey },
          });
          toolStacks.get(e.beatId)?.push(span);
          return;
        }

        case "tool.result": {
          const stack = toolStacks.get(e.beatId);
          if (!stack || stack.length === 0) {
            activeTrace(e.beatId)?.event({
              name: "tool.result",
              metadata: { tool: e.tool, ok: e.ok, durationMs: e.durationMs },
            });
            return;
          }
          const span = stack.pop()!;
          // Langfuse SDK's span.end() stamps the close-time at call time —
          // sub-second skew vs e.ts is acceptable for our cadence.
          span.end({
            output: { ok: e.ok, cause: e.cause, durationMs: e.durationMs },
            level: e.ok ? "DEFAULT" : "ERROR",
            statusMessage: e.ok ? undefined : e.cause,
          });
          return;
        }

        case "tool.denied": {
          activeTrace(e.beatId)?.event({
            name: "tool.denied",
            level: "WARNING",
            metadata: { tool: e.tool, role: e.role, reason: e.reason },
          });
          return;
        }

        case "idempotency.replay": {
          // No active trace context; standalone log entry.
          // Langfuse SDK's top-level `event()` is exposed on traces only,
          // so this becomes a self-contained one-event trace.
          lf.trace({
            name: "idempotency.replay",
            input: { tool: e.tool, key: e.key },
            timestamp: new Date(e.ts),
          });
          return;
        }

        case "task.created":
        case "task.updated":
        case "task.artifact_attached":
        case "artifact.created":
        case "approval.requested":
        case "approval.resolved":
        case "meeting.recorded":
        case "meeting.contribution":
        case "sprint.created":
        case "sprint.completed":
        case "memory.written": {
          // Domain events ride on the active beat trace if any; otherwise
          // create a one-event trace for visibility.
          const beatId = "beatId" in e ? (e as { beatId: string }).beatId : undefined;
          const trace = activeTrace(beatId);
          if (trace) {
            trace.event({ name: e.event, metadata: e as unknown as Record<string, unknown> });
          } else {
            lf.trace({
              name: e.event,
              input: e as unknown as Record<string, unknown>,
              timestamp: new Date(e.ts),
            });
          }
          return;
        }

        case "permission.asked":
        case "permission.replied": {
          activeTrace(e.beatId)?.event({
            name: e.event,
            metadata: e as unknown as Record<string, unknown>,
          });
          return;
        }

        case "agent.reasoning": {
          activeTrace(e.beatId)?.event({
            name: "agent.reasoning",
            metadata: { role: e.role, length: e.text.length },
            input: { text: e.text.length > 4_000 ? `${e.text.slice(0, 4_000)}…` : e.text },
          });
          return;
        }

        case "error": {
          const trace = activeTrace(e.beatId);
          if (trace) {
            trace.event({
              name: "error",
              level: "ERROR",
              statusMessage: e.message,
              metadata: { where: e.where, stack: e.stack },
            });
          } else {
            lf.trace({
              name: "error",
              input: { where: e.where, message: e.message },
              metadata: { stack: e.stack },
              timestamp: new Date(e.ts),
            });
          }
          return;
        }
      }
    },
  };
}

/** For shutdown — flush queued events synchronously before exit. */
export async function flushLangfuseSink(): Promise<void> {
  if (!client) return;
  await client.flushAsync();
}

/** Test helper — drop in-flight beat handles (does not affect Langfuse server). */
export function _resetLangfuseSink(): void {
  beatTraces.clear();
  toolStacks.clear();
  client = null;
}
