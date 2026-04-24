/**
 * Manual smoke test — fires a synthetic beat at Langfuse Cloud and exits.
 * Not part of the test suite. Run with:
 *   bun --env-file ../../.env run src/observability/_smoke.ts
 *
 * Verify by opening https://us.cloud.langfuse.com → Traces and finding
 * an `invoke_agent developer` trace with two child `execute_tool` spans.
 */
import { observability } from "@arceus/contracts";
import { startObservability, _resetObservability } from "./bootstrap.js";

async function main() {
  const ok = startObservability({ serviceName: "arceus-api-smoke" });
  if (!ok) {
    console.error("OTEL bootstrap disabled (missing Langfuse env). Aborting.");
    process.exit(1);
  }

  observability.setSink(observability.otelSink);

  const beatId = `smoke_${Date.now()}`;
  const t0 = Date.now();

  observability.logEvent({
    event: "beat.started",
    beatId,
    companyId: "smoke_company",
    role: "developer",
    sprintId: null,
    trustBand: "standard",
    ts: t0,
  });

  observability.logEvent({
    event: "tool.invoked",
    beatId,
    role: "developer",
    tool: "task_claim",
    args: { taskId: "smoke_task" },
    ts: t0 + 100,
  });
  observability.logEvent({
    event: "tool.result",
    beatId,
    tool: "task_claim",
    ok: true,
    durationMs: 50,
    ts: t0 + 200,
  });

  observability.logEvent({
    event: "tool.invoked",
    beatId,
    role: "developer",
    tool: "artifact_create",
    args: { kind: "code" },
    ts: t0 + 300,
  });
  observability.logEvent({
    event: "tool.result",
    beatId,
    tool: "artifact_create",
    ok: true,
    durationMs: 75,
    ts: t0 + 400,
  });

  observability.logEvent({
    event: "role.handoff",
    from: "developer",
    to: "tester",
    reason: "implementation done",
    beatId,
    ts: t0 + 450,
  });

  observability.logEvent({
    event: "beat.completed",
    beatId,
    role: "developer",
    durationMs: 500,
    verdictOutcome: "pass",
    verdictScore: 0.85,
    ts: t0 + 500,
  });

  console.log(`[smoke] emitted 7 events for beatId=${beatId}, flushing...`);
  // Give the batch exporter a moment, then shut down to force flush.
  await new Promise((r) => setTimeout(r, 1_500));
  await _resetObservability();
  console.log(`[smoke] done. Check Langfuse: search beatId=${beatId}`);
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
