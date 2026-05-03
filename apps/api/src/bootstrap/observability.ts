/**
 * Bootstrap — observability sinks.
 * Spec 32 / Spec 34 v3 PR 12.
 *
 * Each sink lands the same firehose in a different consumer:
 *   pinoSink         → JSON lines on stdout (operator log aggregator)
 *   langfuseSink     → Langfuse SaaS UI for LLM trace debugging
 *   eventBusSink     → in-process ring + /api/inspector/{stream,snapshot}
 *   activityLogSink  → durable Postgres `activity_log` (cold-path SQL paging)
 *   auditViewSink    → feeds /api/audit ring buffer + SSE.
 */
import { observability } from "@arceus/contracts";
import { eventBusSink } from "../observability/event-bus.js";
import { activityLogSink } from "../observability/activity-log-sink.js";
import { auditViewSink } from "../observability/audit-view-sink.js";

export function installObservabilitySinks(): void {
  observability.setSink(
    observability.multiSink([
      observability.pinoSink(),
      observability.langfuseSink(),
      eventBusSink,
      activityLogSink,
      auditViewSink,
    ]),
  );

  // Best-effort flush of Langfuse-batched events on shutdown so we don't lose
  // the final beat. Registered once at boot; idempotent across calls.
  process.once("SIGTERM", () => { void observability.flushLangfuseSink(); });
  process.once("SIGINT", () => { void observability.flushLangfuseSink(); });
}
