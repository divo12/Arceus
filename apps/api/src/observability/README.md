# Observability

Single-emit, multi-sink observability layer. Every event a producer wants to record flows through one entry point — `observability.logEvent(event)` — and lands in N sinks, each tailored to a different consumer.

## Architecture

```
producer
   │
   │ audit({...}) ───────────┐                    audit shim stamps companyId-scoped
   │ emitEmployeeActivity()  │                    sequence + ts and forwards.
   │ emitGraph*()            │
   │ logEvent(event)  ◀──────┘                    other producers call logEvent directly.
   ▼
observability.logEvent(ArceusEvent)
   │
   ▼
multiSink (server.ts) ─ Promise.allSettled, never blocks the producer
   │
   ├─► pinoSink           stdout JSON lines
   ├─► langfuseSink       LLM trace UI (when LANGFUSE_* env vars set)
   ├─► eventBusSink       in-process ring + /api/inspector/{stream,snapshot}
   ├─► activityLogSink    durable Postgres `activity_log` for SQL paging
   └─► auditViewSink      filtered ring + /api/audit/{events,stats,stream}
```

## Sink responsibilities

| Sink | Storage | Lifetime | Read API | Consumer |
|---|---|---|---|---|
| `pinoSink` | stdout (JSON lines) | log aggregator retention (days–months) | grep / Datadog / Loki | ops, on-call |
| `langfuseSink` | Langfuse SaaS via OTLP | 30–90 days | Langfuse web UI | LLM debugging |
| `eventBusSink` | in-process ring (~5K events) | until restart | `/api/inspector/snapshot`, `/api/inspector/stream` | web `/inspector` page |
| `activityLogSink` | Postgres `activity_log` table | forever | SQL queries | inspector cold-path pagination |
| `auditViewSink` | in-process ring (audit-only) + SSE | until restart | `/api/audit/events`, `/api/audit/stats`, `/api/audit/stream` | TUI `use-audit` hooks |

The same event lands in five places because each place serves a different reader. They are not redundant — see [Why five sinks](#why-five-sinks) below.

## Producer ergonomics

| Helper | Where | What it does |
|---|---|---|
| `audit({...})` | `audit-ledger.ts` | Stamps companyId-scoped sequence + ts; emits `event: "audit"` ArceusEvent |
| `auditAgent(companyId, role, eventType, summary)` | `audit-ledger.ts` | Convenience wrapper: `category: "agent_action"` |
| `auditSystem(companyId, eventType, summary)` | `audit-ledger.ts` | Convenience wrapper: `category: "system"` |
| `emitEmployeeActivity(role, type, summary)` | `activity.ts` | Operator-facing employee feed (different shape from audits) |
| `emit*Graph(...)` | `graph-emitter.ts` | Mutates `graph-store` for the execution-graph view |
| `observability.logEvent(event)` | `@arceus/contracts` | Direct firehose entry — for non-audit ArceusEvent variants |

Producers should NOT know about sinks. They emit through one of the helpers above. Adding a new consumer means adding a sink, not changing producers.

## Files in this folder

| File | Purpose |
|---|---|
| `audit-ledger.ts` | Producer-side audit shim (audit / auditAgent / auditSystem). No buffer, no SSE — those moved to `audit-view-sink.ts`. |
| `audit-view-sink.ts` | EventSink subscribing to `event === "audit"`. Owns the audit ring + SSE subscriber set + severity/category filter. Backs `/api/audit/*`. |
| `activity.ts` | Employee activity feed (role/type/summary shape) + `emitActivity` alias. Backs `/api/activity/stream`. |
| `activity-log-sink.ts` | EventSink that writes every ArceusEvent to Postgres `activity_log`. Maintains a `beatId → companyId` resolution map for events that carry only `beatId`. |
| `event-bus.ts` | EventSink + ring buffer for the `/inspector` firehose. Snapshot/subscribe API. |
| `graph-emitter.ts` | Thin wrappers that mutate `graph-store` for the execution-graph view. |
| `graph-store.ts` | In-memory execution graph (sprints, nodes, edges, decisions, beats, file changes). |
| `swallow.ts` | `swallowAndAudit(kind, fn, ctx)` — the canonical "log + don't blow up" wrapper. Use this instead of bare `.catch(() => {})`. |
| `sanitize.ts` | Operator-safe error formatting for HTTP error responses. |
| `cost-recorder.ts` | LLM cost telemetry (`recordLlmCost`). |
| `bootstrap.ts` | Optional OTEL/Langfuse global tracer setup. Called from server.ts when env vars are present. |

## Why five sinks

Each sink lands in a different storage with a different lifetime and a different reader. They cannot replace each other:

- `pinoSink` ↔ `langfuseSink` — both are external destinations, but Langfuse is purpose-built for LLM trace UI; pino is the universal stdout channel ops grep. Drop pino and you lose the always-on log channel.
- `eventBusSink` ↔ `activityLogSink` — two-tier cache. eventBus answers "last 5K events" instantly; activityLog answers "events from last Tuesday filtered to role=ceo" via SQL. Drop the ring and every `/inspector` poll becomes a SQL hit.
- `auditViewSink` ↔ `eventBusSink` — eventBus is the unfiltered firehose. auditView is the curated, sequence-numbered, per-company subset that TUI hooks consume. Filtering on the eventBus side would poison it for non-audit consumers.

If you find a sink with no reader, delete it. That happened to `otelSink` — it had been dormant pointing at Langfuse Cloud (duplicating langfuseSink), so it was retired.

## Adding a new sink

1. Implement `EventSink`:
   ```ts
   import type { observability } from "@arceus/contracts";
   export const myNewSink: observability.EventSink = {
     write(e) {
       // filter, transform, ship
     },
   };
   ```
2. Wire it into the `multiSink` in `server.ts`.
3. Add a row to the table above explaining the consumer.

## Filtering rules

- **Producer-side filters are wrong.** A filter at the producer hides events from *every* sink. If pino + activity_log should see everything, filter at the sink instead.
- **`auditViewSink` filters by severity + category** so the audit ring stays curated. Filtered events still flow to pino, langfuse, eventBus, activity_log.
- **`activityLogSink` drops events without a resolvable `companyId`** because the column is NOT NULL. Other sinks still receive them.

## Hot path guarantees

- `observability.logEvent` is fire-and-forget. Sink errors are swallowed inside `multiSink` via `Promise.allSettled` so a slow Postgres write never blocks pino.
- Producers never await logEvent. The function returns void.
- All sinks must be tolerant of partial event shapes — the schema validates at the producer boundary, but variants differ in which optional fields they carry.

## See also

- `packages/contracts/src/observability/events.ts` — `arceusEventSchema` discriminated union
- `packages/contracts/src/observability/emitter.ts` — `EventSink` interface, `logEvent`, `setSink`, `multiSink`
- `packages/contracts/src/observability/sinks/` — pino / langfuse / memory / multi-sink implementations
- `apps/api/src/config/audit.ts` — `auditConfig` (severity filter, ring size, SSE keep-alive interval)
