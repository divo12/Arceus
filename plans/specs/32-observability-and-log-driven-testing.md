# Spec 32 — Observability & Log-Driven Testing

**Status:** Plan (deferred — pick up after Phase A/B of spec 28) · **Owner:** Platform · **Last Updated:** 2026-04-25
**Touches:** `packages/contracts`, `packages/task-engine` (beat executor), `packages/arceus-mcp` (server middleware), `apps/api` (route handlers)
**Related:** spec 14 (self-evolution-testing), spec 22 (graph debug UI), spec 28 (gap closure)

---

## 0. TL;DR

Build a typed structured-event log as the **single source of truth for both observability and testing**. Tests assert over the event stream rather than mocking internals; the same emit sites power dashboards and soak-run analysis.

Goal of v1: be able to run **one full sprint** (a scripted scenario, no real LLM required) and assert — from logs alone — that every feature behaved correctly across roles, beats, tools, and meetings.

Five deliverables, all in `packages/contracts` + light wiring at the seams:

1. Typed event union (`ArceusEvent`) — discriminated, stable field names
2. Pluggable emitter (pino → stdout in prod, in-memory ring buffer in tests)
3. ~30 emit sites at the system seams (beat executor, MCP middleware, ~6 route handlers)
4. In-test scenario harness (`runScenario()`) that boots the system with a scripted agent
5. Assertion DSL over captured events (`expectLog().toHaveSequence([...])`)

Out of scope for v1: LLM cassettes (deferred; not needed until soak runs), DB persistence of events (defer; stdout/file is enough), live-stream alerting, dashboards.

---

## 1. Motivation

Standard testing approaches don't fit a long-running multi-agent system:

- **Playwright / UI tests** — wrong layer; the agent loop runs headless.
- **Unit tests of agent reasoning** — non-deterministic and expensive.
- **Mocking the MCP server / DB** — hides the bugs that matter (schema drift, idempotency leaks, role gating, role hand-off ordering).

The behaviour we actually want to verify is *what the system did, in what order, on whose behalf, with what arguments*. Structured logs are a natural ground truth for that. If logging is rich and typed, tests reduce to assertions over an event stream — and the same stream powers dashboards once we run for real.

This is the Jepsen pattern adapted to agent systems: **instrument heavily, assert on traces, defer mocking.**

---

## 2. Design

### 2.1 Event taxonomy

Single discriminated union in `packages/contracts/src/events.ts`. Every event has `event` (literal tag), `ts` (epoch ms), and the IDs needed to correlate it to a beat/sprint/company.

```ts
export type ArceusEvent =
  // --- lifecycle ---
  | { event: "beat.started";   beatId: string; companyId: string; role: Role; sprintId: string|null; ts: number }
  | { event: "beat.completed"; beatId: string; role: Role; durationMs: number; ts: number }
  | { event: "role.handoff";   from: Role; to: Role; reason: string; beatId: string; ts: number }
  | { event: "sprint.created"; sprintId: string; goal: string; ts: number }
  | { event: "sprint.completed"; sprintId: string; ts: number }
  // --- MCP middleware ---
  | { event: "tool.invoked";   beatId: string; role: Role; tool: string; args: unknown; idempotencyKey?: string; ts: number }
  | { event: "tool.result";    beatId: string; tool: string; ok: boolean; durationMs: number; ts: number }
  | { event: "tool.denied";    beatId: string; role: Role; tool: string; reason: "not_in_allowlist"|"role_gate"|"governance_block"; ts: number }
  | { event: "idempotency.replay"; tool: string; key: string; ts: number }
  // --- domain (emitted by route handlers) ---
  | { event: "task.created";    taskId: string; sprintId: string|null; assignedRole: Role; ts: number }
  | { event: "task.updated";    taskId: string; patch: string[]; ts: number }
  | { event: "task.artifact_attached"; taskId: string; artifactId: string; ts: number }
  | { event: "artifact.created"; artifactId: string; kind: string; attachedTaskIds: string[]; ts: number }
  | { event: "approval.requested"; approvalId: string; type: ApprovalType; ts: number }
  | { event: "approval.resolved";  approvalId: string; outcome: "approved"|"rejected"; ts: number }
  | { event: "meeting.recorded";   meetingId: string; participants: Role[]; ts: number }
  | { event: "meeting.contribution"; meetingId: string; artifactId: string; position: string; ts: number }
  | { event: "memory.written";     scope: string; sizeBytes: number; ts: number }
  // --- failure ---
  | { event: "error"; where: string; message: string; stack?: string; beatId?: string; ts: number };
```

Rules:

- All test-relevant fields are enums or IDs — **no free-form strings** for things assertions care about (e.g. `reason: "role_not_in_allowlist"`, never `"PM cannot do that"`).
- The union is exhaustive. Adding a new event type is a contracts-package PR — forces a review.
- Events are append-only and immutable.

### 2.2 Emitter

`packages/contracts/src/event-emitter.ts`:

```ts
export interface EventSink { write(e: ArceusEvent): void; }
export function setSink(sink: EventSink): void;
export function logEvent(e: ArceusEvent): void;  // routes to current sink
```

Two built-in sinks:

- **`pinoSink`** — wraps a pino logger; production default; JSON to stdout/file.
- **`memorySink`** — ring buffer with `snapshot(): ArceusEvent[]` and `clear()`; used by tests.

`setSink` is process-global; the test harness swaps it in `beforeEach` and restores after.

### 2.3 Emit sites

Target: ~30 emit calls total. Instrument **seams, not leaves**.

| Site | Events emitted | File (approx) |
|---|---|---|
| Beat executor entry/exit | `beat.started`, `beat.completed`, `error` | `packages/task-engine/src/beat-executor.ts` |
| Role transition logic | `role.handoff` | beat executor |
| MCP server middleware | `tool.invoked`, `tool.result`, `tool.denied`, `idempotency.replay` | `packages/arceus-mcp/src/server.ts` (or a wrapper) |
| Tasks routes | `task.created`, `task.updated`, `task.artifact_attached` | `apps/api/src/routes/tasks.routes.ts` |
| Artifacts routes | `artifact.created` | `apps/api/src/routes/artifacts.routes.ts` |
| Approvals routes | `approval.requested`, `approval.resolved` | `apps/api/src/routes/approvals.routes.ts` |
| Meetings routes | `meeting.recorded`, `meeting.contribution` | `apps/api/src/routes/meetings.routes.ts` |
| Sprint routes | `sprint.created`, `sprint.completed` | `apps/api/src/routes/sprints.routes.ts` |
| Memory writes | `memory.written` | hippocampus / company-runtime write paths |

The MCP middleware emit covers all 39 tools at one site — no per-tool instrumentation needed.

### 2.4 Test harness

`packages/arceus-mcp/test/harness.ts`:

```ts
export interface ScenarioCtx {
  callAs(role: Role, tool: string, args: unknown): Promise<unknown>;
  advanceBeat(role: Role): Promise<void>;
  db: TestDb;
}
export function runScenario(
  fn: (ctx: ScenarioCtx) => Promise<void>
): Promise<ArceusEvent[]>;
```

Responsibilities:

- Boot a fresh test DB (Postgres in docker, or pglite if schema permits).
- Mount the API routes + MCP server in-process.
- Install `memorySink`.
- Run user-supplied scenario function.
- Return captured event log.

A scenario = either direct `callAs(...)` calls (for tool-contract tests) or driving the beat executor with a **scripted agent** — a hand-written mapping from `(role, beatNumber)` to a list of tool calls. No LLM involved.

### 2.5 Assertion DSL

`packages/arceus-mcp/test/log-assertions.ts`:

```ts
class LogAssertions {
  toContain(matcher: Partial<ArceusEvent>): this;
  toHaveSequence(matchers: Partial<ArceusEvent>[]): this;       // ordered, gaps allowed
  toHaveStrictSequence(matchers: Partial<ArceusEvent>[]): this; // ordered, no gaps
  toHaveCount(matcher: Partial<ArceusEvent>, n: number): this;
  forBeat(beatId: string): LogAssertions;  // scoped view
  forRole(role: Role): LogAssertions;
  forSprint(sprintId: string): LogAssertions;
  not: LogAssertions;
}
export function expectLog(events: ArceusEvent[]): LogAssertions;
```

Matchers are partial deep-equals. Failures print the matcher, the closest near-misses, and a windowed slice of the event stream around the failure point.

### 2.6 Example test

```ts
test("phase A.2: task_create with referenceArtifactIds attaches at creation", async () => {
  const log = await runScenario(async (ctx) => {
    const a = await ctx.callAs("engineer", "artifact_create",
      { kind: "code", title: "impl", content: "..." });
    await ctx.callAs("pm", "task_create", {
      title: "review impl",
      assignedRole: "engineer",
      referenceArtifactIds: [(a as any).id],
    });
  });

  expectLog(log).toHaveSequence([
    { event: "tool.invoked", tool: "artifact_create", role: "engineer" },
    { event: "artifact.created" },
    { event: "tool.invoked", tool: "task_create", role: "pm" },
    { event: "task.created" },
    { event: "task.artifact_attached" },
  ]);
  expectLog(log).not.toContain({ event: "error" });
  expectLog(log).not.toContain({ event: "tool.denied" });
});
```

---

## 3. The "one full sprint" milestone

The acceptance test for v1 of this spec is a single scenario:

> **Scenario `sprint-hello-world`:** scripted agents drive CEO → PM → Engineer → QA across one full sprint (sprint create → tasks → artifacts → meetings → approvals → sprint complete). Runs in <10s, no LLM.

Then a **single test file** asserts dozens of properties from the captured log:

- Exactly one `sprint.created` and one `sprint.completed`, with the second strictly later.
- Every `task.created` has a downstream `tool.result {ok:true}` for the task.
- Every `artifact.created` was followed by at least one `task.artifact_attached`.
- Every `approval.requested` was eventually `approval.resolved`.
- `tool.denied` count == 0.
- `idempotency.replay` count == 0 (clean run).
- `error` count == 0.
- Role hand-off graph matches the expected order (`ceo → pm → engineer → qa → pm`).
- Every tool the system claims to support was invoked at least once across the matrix of scenarios.

If that test passes, we have *trace-level proof* that one sprint works end-to-end. From there, the same harness scales to multi-sprint scenarios with no new infrastructure.

---

## 4. Phasing

| Phase | Deliverable | Est. |
|---|---|---|
| **32.1** | `events.ts` union + `event-emitter.ts` + `pinoSink` + `memorySink` | 0.5 d |
| **32.2** | Wire ~30 emit sites at the seams | 1 d |
| **32.3** | Test harness (`runScenario`, scripted-agent driver, test DB boot) | 1 d |
| **32.4** | Assertion DSL + matcher diagnostics | 0.5 d |
| **32.5** | `sprint-hello-world` scenario + the umbrella assertion suite | 1 d |
| **32.6** | Backfill tests for spec 28 phases A–I (one assertion file per phase) | 1.5 d |

Total: **~5.5 days**. Independent of spec 28 phases B–I; should land between A and the rest.

---

## 5. Tooling decisions (defaults; revisit at start)

- **Logger:** `pino` (fast, JSON-native, plays well with both sinks).
- **Test runner:** `vitest` (watch mode, async-friendly, plays well with assertion chaining).
- **Test DB:** docker Postgres via testcontainers — schema uses pg-specific features (jsonb, citext) so pglite is risky.
- **MCP client in tests:** real `@modelcontextprotocol/sdk` client over stdio — exercises the actual wire format.

---

## 6. Non-goals (explicitly deferred)

- **LLM response cassettes / record-replay.** Not needed until we run thousands of beats; revisit when soak runs become real.
- **DB persistence of events.** Stdout JSON + log shipper is enough for v1.
- **Live-stream alerting and dashboards.** Same event stream will support them later, but out of scope here.
- **Property-based / fuzz testing.** Layer on top once the deterministic harness is solid.
- **Invariant checks on live runs.** The DSL works for that, but wiring it into the live executor is a follow-up.

---

## 7. Open questions

1. Should `tool.invoked` redact large `args` payloads (e.g. artifact content) or hash them? Probably hash for prod, keep raw in tests.
2. Where exactly does the beat executor live today — `apps/api`, `packages/task-engine`, or both? Confirm before instrumenting.
3. Do we want a single global emitter (simpler) or context-passed emitter (testable without globals)? Lean global with `setSink`, accept the trade-off.
4. Do memory writes need their own event, or fold into a generic `db.write`? Keep `memory.written` — memory growth is a known long-run concern.

---

## 8. Exit criteria

- [ ] `ArceusEvent` union published from `@arceus/contracts`.
- [ ] `pinoSink` produces JSON on stdout in prod; `memorySink` captures in tests.
- [ ] All ~30 emit sites wired; grep for `logEvent(` matches the table in §2.3.
- [ ] `runScenario` boots a fresh DB + API + MCP server in <2s.
- [ ] `expectLog` DSL has unit tests for each matcher.
- [ ] `sprint-hello-world` scenario passes deterministically 10× in a row.
- [ ] At least one assertion file exists per spec 28 phase (A–I) that has shipped.
- [ ] `pnpm test` runs the whole suite in <30s on a developer laptop.
