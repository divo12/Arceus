/**
 * Phase 1 verification for spec 32.
 * Covers: event schema validation, memory sink behaviour, pino sink smoke,
 * multi-sink fan-out, emitter safety, discriminated-union narrowing.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  arceusEventSchema,
  parseEvent,
  type ArceusEvent,
} from "./events.js";
import { logEvent, setSink, getSink, resetSink } from "./emitter.js";
import { memorySink } from "./sinks/memory-sink.js";
import { pinoSink } from "./sinks/pino-sink.js";
import { multiSink } from "./sinks/multi-sink.js";

// ── Fixtures ──────────────────────────────────────────────────

const BEAT_STARTED: ArceusEvent = {
  event: "beat.started",
  beatId: "beat_1",
  companyId: "co_1",
  role: "developer",
  sprintId: "sprint_1",
  trustBand: "standard",
  ts: 1_000,
};
const BEAT_COMPLETED: ArceusEvent = {
  event: "beat.completed",
  beatId: "beat_1",
  role: "developer",
  durationMs: 250,
  verdictOutcome: "pass",
  verdictScore: 0.85,
  ts: 2_000,
};
const TOOL_INVOKED: ArceusEvent = {
  event: "tool.invoked",
  beatId: "beat_1",
  role: "developer",
  tool: "task_claim",
  args: { taskId: "t_1" },
  ts: 1_500,
};
const TOOL_DENIED: ArceusEvent = {
  event: "tool.denied",
  beatId: "beat_1",
  role: "developer",
  tool: "sprint_create",
  reason: "not_in_allowlist",
  ts: 1_600,
};
const TASK_CREATED: ArceusEvent = {
  event: "task.created",
  taskId: "t_1",
  companyId: "co_1",
  sprintId: "sprint_1",
  assignedRole: "developer",
  ts: 1_700,
};

afterEach(() => {
  resetSink();
});

// ── Schema validation ─────────────────────────────────────────

describe("arceusEventSchema", () => {
  test("accepts every canonical fixture", () => {
    for (const fixture of [BEAT_STARTED, BEAT_COMPLETED, TOOL_INVOKED, TOOL_DENIED, TASK_CREATED]) {
      const result = arceusEventSchema.safeParse(fixture);
      expect(result.success).toBe(true);
    }
  });

  test("rejects an invalid role", () => {
    const bad = { ...BEAT_STARTED, role: "engineer" };
    expect(arceusEventSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects missing required fields", () => {
    const { companyId, ...missingCompany } = BEAT_STARTED;
    expect(arceusEventSchema.safeParse(missingCompany).success).toBe(false);
  });

  test("rejects out-of-range verdictScore", () => {
    const bad = { ...BEAT_COMPLETED, verdictScore: 1.5 };
    expect(arceusEventSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects unknown tool.denied reason", () => {
    const bad = { ...TOOL_DENIED, reason: "because i said so" };
    expect(arceusEventSchema.safeParse(bad).success).toBe(false);
  });

  test("parseEvent returns null on invalid input, value on valid", () => {
    expect(parseEvent("nope")).toBeNull();
    expect(parseEvent({ event: "bogus" })).toBeNull();
    expect(parseEvent(BEAT_STARTED)?.event).toBe("beat.started");
  });

  test("round-trips via JSON", () => {
    const encoded = JSON.stringify(BEAT_STARTED);
    const decoded = JSON.parse(encoded);
    const parsed = arceusEventSchema.safeParse(decoded);
    expect(parsed.success).toBe(true);
  });
});

// ── Discriminated-union narrowing ─────────────────────────────

describe("ArceusEvent type narrowing", () => {
  test("TypeScript narrows fields per variant", () => {
    const e: ArceusEvent = TOOL_INVOKED;
    if (e.event === "tool.invoked") {
      // If this block typechecks, narrowing works.
      const _tool: string = e.tool;
      const _role: typeof e.role = e.role;
      expect(_tool).toBe("task_claim");
    } else {
      throw new Error("unreachable");
    }
  });
});

// ── memorySink ────────────────────────────────────────────────

describe("memorySink", () => {
  test("captures events in insertion order", () => {
    const sink = memorySink();
    sink.write(BEAT_STARTED);
    sink.write(TOOL_INVOKED);
    sink.write(BEAT_COMPLETED);
    const snap = sink.snapshot();
    expect(snap.length).toBe(3);
    expect(snap[0].event).toBe("beat.started");
    expect(snap[1].event).toBe("tool.invoked");
    expect(snap[2].event).toBe("beat.completed");
  });

  test("snapshot is a defensive copy", () => {
    const sink = memorySink();
    sink.write(BEAT_STARTED);
    const snap = sink.snapshot();
    sink.write(BEAT_COMPLETED);
    expect(snap.length).toBe(1);
    expect(sink.size()).toBe(2);
  });

  test("clear() resets the buffer", () => {
    const sink = memorySink();
    sink.write(BEAT_STARTED);
    sink.write(BEAT_COMPLETED);
    sink.clear();
    expect(sink.size()).toBe(0);
  });

  test("respects capacity — drops oldest on overflow", () => {
    const sink = memorySink({ capacity: 2 });
    sink.write(BEAT_STARTED);
    sink.write(TOOL_INVOKED);
    sink.write(BEAT_COMPLETED);
    const snap = sink.snapshot();
    expect(snap.length).toBe(2);
    expect(snap[0].event).toBe("tool.invoked");
    expect(snap[1].event).toBe("beat.completed");
  });
});

// ── pinoSink ──────────────────────────────────────────────────

describe("pinoSink", () => {
  test("accepts events without throwing", () => {
    const sink = pinoSink({ level: "silent" });
    expect(() => sink.write(BEAT_STARTED)).not.toThrow();
    expect(() => sink.write(TOOL_INVOKED)).not.toThrow();
  });

  test("honors a caller-supplied logger via duck-typing", () => {
    const calls: Array<Record<string, unknown>> = [];
    // minimal logger shim compatible with pino's .info(obj)
    const fakeLogger = {
      level: "info",
      info: (obj: Record<string, unknown>) => calls.push(obj),
    } as unknown as Parameters<typeof pinoSink>[0] extends infer O
      ? O extends { logger?: infer L }
        ? L
        : never
      : never;

    const sink = pinoSink({ logger: fakeLogger as never });
    sink.write(BEAT_STARTED);
    expect(calls.length).toBe(1);
    expect((calls[0] as { event: string }).event).toBe("beat.started");
  });
});

// ── multiSink ─────────────────────────────────────────────────

describe("multiSink", () => {
  test("fans out to every inner sink", async () => {
    const a = memorySink();
    const b = memorySink();
    const fan = multiSink([a, b]);
    await fan.write(BEAT_STARTED);
    expect(a.size()).toBe(1);
    expect(b.size()).toBe(1);
  });

  test("a thrown sink does not stop the others", async () => {
    const healthy = memorySink();
    const broken = {
      write() {
        throw new Error("boom");
      },
    };
    const fan = multiSink([broken, healthy]);
    await fan.write(BEAT_COMPLETED);
    expect(healthy.size()).toBe(1);
  });

  test("an async rejecting sink does not stop the others", async () => {
    const healthy = memorySink();
    const rejecting = {
      async write() {
        throw new Error("async boom");
      },
    };
    const fan = multiSink([rejecting, healthy]);
    await fan.write(TOOL_INVOKED);
    expect(healthy.size()).toBe(1);
  });
});

// ── emitter ───────────────────────────────────────────────────

describe("logEvent + setSink", () => {
  beforeEach(() => {
    resetSink();
  });

  test("defaults to a no-op sink (safe to call before setSink)", () => {
    expect(() => logEvent(BEAT_STARTED)).not.toThrow();
  });

  test("routes through the installed sink", () => {
    const sink = memorySink();
    setSink(sink);
    logEvent(BEAT_STARTED);
    logEvent(TOOL_INVOKED);
    expect(sink.size()).toBe(2);
    expect(sink.snapshot()[0].event).toBe("beat.started");
  });

  test("swallows sink.write exceptions (hot path stays alive)", () => {
    setSink({
      write() {
        throw new Error("sink broken");
      },
    });
    expect(() => logEvent(BEAT_STARTED)).not.toThrow();
  });

  test("swallows async sink rejections (fire-and-forget)", async () => {
    setSink({
      async write() {
        throw new Error("rejected");
      },
    });
    expect(() => logEvent(BEAT_STARTED)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10)); // let microtask queue drain
  });

  test("getSink returns the installed sink (useful for test peeks)", () => {
    const sink = memorySink();
    setSink(sink);
    expect(getSink()).toBe(sink);
  });

  test("resetSink reverts to the default no-op", () => {
    const sink = memorySink();
    setSink(sink);
    resetSink();
    logEvent(BEAT_STARTED);
    expect(sink.size()).toBe(0);
  });
});

// ── End-to-end flow ───────────────────────────────────────────

describe("end-to-end: multi-sink under logEvent", () => {
  test("one emit reaches every sink", async () => {
    const a = memorySink();
    const b = memorySink();
    setSink(multiSink([a, b]));
    logEvent(BEAT_STARTED);
    logEvent(TOOL_INVOKED);
    // multi-sink is async; give microtask queue a tick
    await new Promise((r) => setTimeout(r, 5));
    expect(a.size()).toBe(2);
    expect(b.size()).toBe(2);
    expect(a.snapshot().map((e) => e.event)).toEqual(["beat.started", "tool.invoked"]);
  });
});
