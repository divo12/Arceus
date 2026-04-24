/**
 * OpenTelemetry sink — maps each ArceusEvent to OTEL spans / span events
 * following the GenAI semantic conventions.
 *
 * Span topology:
 *   beat.started      → starts a parent span `invoke_agent {role}`
 *   beat.completed    → ends the parent span (verdict on attributes)
 *   tool.invoked      → starts a child span `execute_tool {tool}`
 *   tool.result       → ends the most-recent unfinished tool span on this beat
 *   tool.denied/error → span event with status=error
 *   role.handoff,
 *   permission.*,
 *   agent.reasoning,
 *   memory.written,
 *   task.*, artifact.*,
 *   approval.*, meeting.*,
 *   sprint.*           → span events on the parent beat span (or root if none)
 *
 * Tools execute sequentially within a beat, so per-beat stack works for
 * matching tool.invoked → tool.result. If we ever fan out tools concurrently
 * we'll need a callId field on the events.
 */
import {
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from "@opentelemetry/api";
import type { EventSink } from "../emitter.js";
import type { ArceusEvent } from "../events.js";

const TRACER_NAME = "arceus";

interface BeatSpanState {
  span: Span;
  toolStack: Span[]; // most-recent unfinished tool span at the top
}

const beatSpans = new Map<string, BeatSpanState>();

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

function attrString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}

function eventEpochNanos(ts: number): [number, number] {
  // OTEL accepts a Date or [seconds, nanos]. Use ms→ns where possible.
  const seconds = Math.floor(ts / 1000);
  const nanos = (ts % 1000) * 1_000_000;
  return [seconds, nanos];
}

function addSpanEvent(span: Span | undefined, name: string, attrs: Record<string, unknown>, ts: number) {
  if (!span) return;
  const stringified: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      stringified[k] = v;
    } else {
      stringified[k] = attrString(v);
    }
  }
  span.addEvent(name, stringified, ts);
}

function activeSpan(beatId: string | undefined): Span | undefined {
  if (!beatId) return undefined;
  return beatSpans.get(beatId)?.span;
}

export const otelSink: EventSink = {
  write(e: ArceusEvent): void {
    const tracer = getTracer();

    switch (e.event) {
      case "beat.started": {
        const span = tracer.startSpan(
          `invoke_agent ${e.role}`,
          {
            kind: SpanKind.INTERNAL,
            startTime: eventEpochNanos(e.ts),
            attributes: {
              "gen_ai.operation.name": "invoke_agent",
              "gen_ai.agent.name": e.role,
              "gen_ai.conversation.id": e.companyId,
              "arceus.beat.id": e.beatId,
              "arceus.company.id": e.companyId,
              "arceus.role": e.role,
              "arceus.trust.band": e.trustBand,
              ...(e.sprintId ? { "arceus.sprint.id": e.sprintId } : {}),
            },
          },
        );
        beatSpans.set(e.beatId, { span, toolStack: [] });
        return;
      }

      case "beat.completed": {
        const state = beatSpans.get(e.beatId);
        if (!state) return;
        // Close any unfinished tool spans defensively.
        while (state.toolStack.length > 0) {
          const orphan = state.toolStack.pop()!;
          orphan.setStatus({ code: SpanStatusCode.ERROR, message: "tool span unclosed at beat end" });
          orphan.end();
        }
        state.span.setAttributes({
          "arceus.verdict.outcome": e.verdictOutcome,
          "arceus.verdict.score": e.verdictScore,
          "arceus.duration.ms": e.durationMs,
        });
        if (e.verdictOutcome === "fail") {
          state.span.setStatus({ code: SpanStatusCode.ERROR, message: "beat verdict failed" });
        }
        state.span.end(eventEpochNanos(e.ts));
        beatSpans.delete(e.beatId);
        return;
      }

      case "beat.idle": {
        addSpanEvent(activeSpan(e.beatId), "beat.idle", { stalledMs: e.stalledMs }, e.ts);
        return;
      }

      case "role.handoff": {
        addSpanEvent(activeSpan(e.beatId), "role.handoff", { from: e.from, to: e.to, reason: e.reason }, e.ts);
        return;
      }

      case "tool.invoked": {
        const state = beatSpans.get(e.beatId);
        const parentCtx = state ? trace.setSpan(context.active(), state.span) : undefined;
        const attributes: Record<string, string | number | boolean> = {
          "gen_ai.tool.name": e.tool,
          "arceus.role": e.role,
          "arceus.beat.id": e.beatId,
        };
        if (e.idempotencyKey) {
          attributes["arceus.idempotency.key"] = e.idempotencyKey;
        }
        const span = parentCtx
          ? tracer.startSpan(
              `execute_tool ${e.tool}`,
              { kind: SpanKind.INTERNAL, startTime: eventEpochNanos(e.ts), attributes },
              parentCtx,
            )
          : tracer.startSpan(`execute_tool ${e.tool}`, {
              kind: SpanKind.INTERNAL,
              startTime: eventEpochNanos(e.ts),
              attributes,
            });
        if (state) {
          state.toolStack.push(span);
        } else {
          // No active beat — close immediately as a self-contained span.
          span.end(eventEpochNanos(e.ts + 1));
        }
        return;
      }

      case "tool.result": {
        const state = beatSpans.get(e.beatId);
        if (!state || state.toolStack.length === 0) {
          // Orphan result — still capture it as a span event on the beat span.
          addSpanEvent(activeSpan(e.beatId), "tool.result", { tool: e.tool, ok: e.ok, durationMs: e.durationMs }, e.ts);
          return;
        }
        const span = state.toolStack.pop()!;
        span.setAttributes({
          "arceus.tool.ok": e.ok,
          "arceus.tool.duration.ms": e.durationMs,
          ...(e.cause ? { "arceus.tool.cause": e.cause } : {}),
        });
        if (!e.ok) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: e.cause ?? "tool failed" });
        }
        span.end(eventEpochNanos(e.ts));
        return;
      }

      case "tool.denied": {
        addSpanEvent(activeSpan(e.beatId), "tool.denied", { tool: e.tool, role: e.role, reason: e.reason }, e.ts);
        const span = activeSpan(e.beatId);
        span?.setAttribute("arceus.has_denial", true);
        return;
      }

      case "idempotency.replay": {
        addSpanEvent(undefined, "idempotency.replay", { tool: e.tool, key: e.key }, e.ts);
        return;
      }

      case "task.created":
      case "task.updated":
      case "task.artifact_attached": {
        const span = activeSpan("beatId" in e ? (e as { beatId: string }).beatId : undefined);
        addSpanEvent(span, e.event, { ...e, event: undefined }, e.ts);
        return;
      }

      case "artifact.created": {
        addSpanEvent(undefined, "artifact.created", {
          artifactId: e.artifactId,
          kind: e.kind,
          attachedTaskCount: e.attachedTaskIds.length,
        }, e.ts);
        return;
      }

      case "approval.requested":
      case "approval.resolved": {
        addSpanEvent(undefined, e.event, { approvalId: e.approvalId, ...(e.event === "approval.resolved" ? { outcome: e.outcome } : {}) }, e.ts);
        return;
      }

      case "meeting.recorded":
      case "meeting.contribution": {
        addSpanEvent(undefined, e.event, { meetingId: e.meetingId }, e.ts);
        return;
      }

      case "sprint.created":
      case "sprint.completed": {
        addSpanEvent(undefined, e.event, { sprintId: e.sprintId }, e.ts);
        return;
      }

      case "memory.written": {
        addSpanEvent(undefined, "memory.written", { scope: e.scope, sizeBytes: e.sizeBytes }, e.ts);
        return;
      }

      case "permission.asked":
      case "permission.replied": {
        const span = activeSpan(e.beatId);
        addSpanEvent(span, e.event, { tool: e.tool, ...(e.event === "permission.replied" ? { granted: e.granted } : {}) }, e.ts);
        return;
      }

      case "agent.reasoning": {
        const span = activeSpan(e.beatId);
        // Reasoning text can be long — truncate to keep span event payloads sane.
        const text = e.text.length > 4_000 ? `${e.text.slice(0, 4_000)}…` : e.text;
        addSpanEvent(span, "agent.reasoning", { role: e.role, text }, e.ts);
        return;
      }

      case "error": {
        const span = activeSpan(e.beatId);
        if (span) {
          span.recordException({ name: "ArceusError", message: e.message, stack: e.stack });
          span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        } else {
          // Standalone error span so it shows up in the trace browser.
          const standalone = getTracer().startSpan("arceus.error", {
            kind: SpanKind.INTERNAL,
            startTime: eventEpochNanos(e.ts),
            attributes: {
              "arceus.error.where": e.where,
              "arceus.error.message": e.message,
            },
          });
          standalone.recordException({ name: "ArceusError", message: e.message, stack: e.stack });
          standalone.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
          standalone.end(eventEpochNanos(e.ts + 1));
        }
        return;
      }
    }
  },
};

/** Test helper — drop all in-flight beat spans (e.g. between tests). */
export function _resetBeatSpans(): void {
  for (const state of beatSpans.values()) {
    state.span.end();
    for (const tool of state.toolStack) tool.end();
  }
  beatSpans.clear();
}
