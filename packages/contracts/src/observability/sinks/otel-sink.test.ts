/**
 * Spec 32 Phase 2 — OTEL sink unit tests.
 *
 * Uses the in-memory span exporter from @opentelemetry/sdk-trace-base so we
 * can assert on the exact spans the sink would have shipped to Langfuse.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { ArceusEvent } from "../events.js";
import { otelSink, _resetBeatSpans } from "./otel-sink.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  _resetBeatSpans();
  exporter.reset();
  await provider.shutdown();
  trace.disable();
});

function emit(...events: ArceusEvent[]): void {
  for (const e of events) otelSink.write(e);
}

function spans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

const beatStart = (id = "beat_1", role: ArceusEvent["role" & keyof ArceusEvent] | "developer" = "developer", ts = 1_000): ArceusEvent => ({
  event: "beat.started",
  beatId: id,
  companyId: "co_1",
  role: role as "developer",
  sprintId: null,
  trustBand: "standard",
  ts,
});
const beatEnd = (id = "beat_1", ts = 2_000, outcome: "pass" | "fail" = "pass"): ArceusEvent => ({
  event: "beat.completed",
  beatId: id,
  role: "developer",
  durationMs: ts - 1_000,
  verdictOutcome: outcome,
  verdictScore: outcome === "pass" ? 0.9 : 0.2,
  ts,
});
const toolCall = (tool: string, ts: number): ArceusEvent => ({
  event: "tool.invoked",
  beatId: "beat_1",
  role: "developer",
  tool,
  args: {},
  ts,
});
const toolDone = (tool: string, ts: number, ok = true): ArceusEvent => ({
  event: "tool.result",
  beatId: "beat_1",
  tool,
  ok,
  durationMs: 50,
  ts,
});

// ── Tests ─────────────────────────────────────────────────────

describe("otelSink — beat lifecycle", () => {
  test("beat.started + beat.completed produces exactly one parent span", () => {
    emit(beatStart(), beatEnd());
    const ss = spans();
    expect(ss.length).toBe(1);
    expect(ss[0].name).toBe("invoke_agent developer");
    expect(ss[0].attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(ss[0].attributes["gen_ai.agent.name"]).toBe("developer");
    expect(ss[0].attributes["arceus.beat.id"]).toBe("beat_1");
    expect(ss[0].attributes["arceus.verdict.outcome"]).toBe("pass");
  });

  test("fail verdict marks span status ERROR", () => {
    emit(beatStart(), beatEnd("beat_1", 2_000, "fail"));
    const ss = spans();
    expect(ss.length).toBe(1);
    expect(ss[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  test("orphan beat.completed (no matching start) is a no-op", () => {
    emit(beatEnd("beat_x"));
    expect(spans().length).toBe(0);
  });
});

describe("otelSink — tool nesting", () => {
  test("tool.invoked + tool.result creates a child span under the beat", () => {
    emit(beatStart(), toolCall("task_claim", 1_100), toolDone("task_claim", 1_200), beatEnd());
    const ss = spans();
    expect(ss.length).toBe(2);
    const tool = ss.find((s) => s.name === "execute_tool task_claim");
    const beat = ss.find((s) => s.name === "invoke_agent developer");
    expect(tool).toBeDefined();
    expect(beat).toBeDefined();
    expect(tool!.parentSpanId).toBe(beat!.spanContext().spanId);
    expect(tool!.attributes["gen_ai.tool.name"]).toBe("task_claim");
    expect(tool!.attributes["arceus.tool.ok"]).toBe(true);
  });

  test("tool failure — span status ERROR with cause", () => {
    emit(
      beatStart(),
      toolCall("task_claim", 1_100),
      { event: "tool.result", beatId: "beat_1", tool: "task_claim", ok: false, cause: "already_claimed", durationMs: 30, ts: 1_200 },
      beatEnd(),
    );
    const ss = spans();
    const tool = ss.find((s) => s.name === "execute_tool task_claim")!;
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.attributes["arceus.tool.cause"]).toBe("already_claimed");
  });

  test("multiple tool calls in one beat all parent under the beat span", () => {
    emit(
      beatStart(),
      toolCall("a", 1_100),
      toolDone("a", 1_150),
      toolCall("b", 1_200),
      toolDone("b", 1_250),
      toolCall("c", 1_300),
      toolDone("c", 1_350),
      beatEnd(),
    );
    const ss = spans();
    expect(ss.length).toBe(4); // 1 beat + 3 tools
    const beat = ss.find((s) => s.name === "invoke_agent developer")!;
    for (const name of ["execute_tool a", "execute_tool b", "execute_tool c"]) {
      const tool = ss.find((s) => s.name === name);
      expect(tool).toBeDefined();
      expect(tool!.parentSpanId).toBe(beat.spanContext().spanId);
    }
  });

  test("beat.completed closes any unfinished tool spans (defensive)", () => {
    emit(beatStart(), toolCall("a", 1_100), beatEnd());
    const ss = spans();
    expect(ss.length).toBe(2);
    const tool = ss.find((s) => s.name === "execute_tool a")!;
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.status.message).toContain("unclosed");
  });
});

describe("otelSink — span events", () => {
  test("role.handoff lands as a span event on the beat span", () => {
    emit(
      beatStart(),
      { event: "role.handoff", from: "ceo", to: "pm", reason: "strategy ready", beatId: "beat_1", ts: 1_500 },
      beatEnd(),
    );
    const beat = spans().find((s) => s.name === "invoke_agent developer")!;
    const event = beat.events.find((e) => e.name === "role.handoff");
    expect(event).toBeDefined();
    expect(event!.attributes?.from).toBe("ceo");
    expect(event!.attributes?.to).toBe("pm");
  });

  test("permission.asked + permission.replied land as span events", () => {
    emit(
      beatStart(),
      { event: "permission.asked", beatId: "beat_1", tool: "bash", ts: 1_300 },
      { event: "permission.replied", beatId: "beat_1", tool: "bash", granted: true, ts: 1_400 },
      beatEnd(),
    );
    const beat = spans().find((s) => s.name === "invoke_agent developer")!;
    expect(beat.events.find((e) => e.name === "permission.asked")).toBeDefined();
    const reply = beat.events.find((e) => e.name === "permission.replied");
    expect(reply!.attributes?.granted).toBe(true);
  });

  test("agent.reasoning truncates large payloads", () => {
    const big = "x".repeat(10_000);
    emit(
      beatStart(),
      { event: "agent.reasoning", beatId: "beat_1", role: "developer", text: big, ts: 1_500 },
      beatEnd(),
    );
    const beat = spans().find((s) => s.name === "invoke_agent developer")!;
    const event = beat.events.find((e) => e.name === "agent.reasoning")!;
    const text = event.attributes?.text as string;
    expect(text.length).toBeLessThanOrEqual(4_001);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("otelSink — standalone events", () => {
  test("error without active beat creates a standalone error span", () => {
    emit({ event: "error", where: "background_worker", message: "boom", ts: 1_000 });
    const ss = spans();
    expect(ss.length).toBe(1);
    expect(ss[0].name).toBe("arceus.error");
    expect(ss[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(ss[0].attributes["arceus.error.where"]).toBe("background_worker");
  });

  test("error with active beat marks the beat span as failed and records exception", () => {
    emit(
      beatStart(),
      { event: "error", where: "tool_handler", message: "kaboom", beatId: "beat_1", ts: 1_500 },
      beatEnd("beat_1", 2_000, "fail"),
    );
    const beat = spans().find((s) => s.name === "invoke_agent developer")!;
    expect(beat.status.code).toBe(SpanStatusCode.ERROR);
    expect(beat.events.find((e) => e.name === "exception")).toBeDefined();
  });
});

describe("otelSink — concurrent beats", () => {
  test("two beats running in parallel maintain independent tool stacks", () => {
    emit(
      beatStart("beat_a", "developer", 1_000),
      beatStart("beat_b", "tester" as never, 1_010),
      // a's tool
      { event: "tool.invoked", beatId: "beat_a", role: "developer", tool: "task_claim", args: {}, ts: 1_100 },
      // b's tool
      { event: "tool.invoked", beatId: "beat_b", role: "tester", tool: "task_verify", args: {}, ts: 1_110 },
      // close in reverse order
      { event: "tool.result", beatId: "beat_b", tool: "task_verify", ok: true, durationMs: 10, ts: 1_120 },
      { event: "tool.result", beatId: "beat_a", tool: "task_claim", ok: true, durationMs: 30, ts: 1_130 },
      beatEnd("beat_a", 2_000),
      beatEnd("beat_b", 2_010),
    );
    const ss = spans();
    // 2 beats + 2 tools
    expect(ss.length).toBe(4);
    const beatA = ss.find((s) => s.name === "invoke_agent developer")!;
    const beatB = ss.find((s) => s.name === "invoke_agent tester")!;
    const toolA = ss.find((s) => s.name === "execute_tool task_claim")!;
    const toolB = ss.find((s) => s.name === "execute_tool task_verify")!;
    expect(toolA.parentSpanId).toBe(beatA.spanContext().spanId);
    expect(toolB.parentSpanId).toBe(beatB.spanContext().spanId);
  });
});
