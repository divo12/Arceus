/**
 * Audit Ledger — Spec 11 Control Plane
 *
 * Append-only event log with:
 *  - In-memory ring buffer (always works, fast)
 *  - Postgres persistence (when DB is available, batched flush)
 *  - SSE streaming to connected /logs viewers
 *
 * Config: apps/api/src/config/audit.json (overridable via ARCEUS_AUDIT_* env vars)
 */

import { randomUUID } from "node:crypto";
import type { AuditCategory, AuditSeverity, AuditEvent } from "@arceus/contracts";
import { observability, roleTypeSchema, type RoleType } from "@arceus/contracts";
import { auditConfig } from "../config/audit.js";

// Spec 32 Phase 5 (Option B): the legacy `auditEventsTable` writer was retired.
// flushToObservability re-emits each buffered AuditEvent through
// observability.logEvent using the `audit` variant. Single backend; routed
// through pino + langfuseSink + activityLogSink (Phase 5) like every other
// ArceusEvent. The `hippocampus.audit_events` table is no longer written to.

// ── Severity ordering (for filtering) ──────────────────────

const SEVERITY_RANK: Record<AuditSeverity, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// ── In-memory ring buffer ──────────────────────────────────

const buffer: AuditEvent[] = [];
const maxBuffer = auditConfig.memoryBufferSize;
const sequenceCounters = new Map<string, number>(); // companyId → next sequence

function nextSequence(companyId: string): number {
  const current = sequenceCounters.get(companyId) ?? 0;
  const next = current + 1;
  sequenceCounters.set(companyId, next);
  return next;
}

// ── SSE subscribers ────────────────────────────────────────

type SseWriter = (event: AuditEvent) => void;
const subscribers = new Set<SseWriter>();

/** Subscribe an SSE writer to receive live audit events. Returns an unsubscribe function. */
export function subscribeSse(writer: SseWriter) {
  subscribers.add(writer);
  return () => { subscribers.delete(writer); };
}

function broadcast(event: AuditEvent) {
  for (const writer of subscribers) {
    try { writer(event); } catch { subscribers.delete(writer); }
  }
}

// ── Flush queue → observability sink ───────────────────────

/**
 * Audit C9 (F-391/F-392) — bounded queue with drop-oldest backpressure.
 *
 * The flush timer drains `pendingFlush` in batches of
 * `auditConfig.dbFlushBatchSize` per `auditConfig.dbFlushIntervalMs`.
 * If audits arrive faster than the timer can drain (slow sink, paused
 * flush, or audit storm during a sprint failure), we cap the queue at
 * MAX_PENDING_FLUSH and drop oldest with a counter so backpressure is
 * visible at `/api/audit/status` instead of growing the heap silently.
 */
const MAX_PENDING_FLUSH = 10_000;
const pendingFlush: AuditEvent[] = [];
let pendingFlushDropped = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Coerce the legacy free-form `agentRole: string | null` into a typed
 * `RoleType | null`. Anything that isn't a real role becomes null (system
 * events, e.g. `_system` startup notices, have no role).
 */
function toRoleType(role: string | null | undefined): RoleType | null {
  if (!role) return null;
  const parsed = roleTypeSchema.safeParse(role);
  return parsed.success ? parsed.data : null;
}

/**
 * Drain the pending buffer through observability.logEvent. The legacy
 * `hippocampus.audit_events` writer is gone — pino + Langfuse + the Phase 5
 * activity_log sink decide where data actually lands. logEvent already
 * swallows sink errors, so this never throws.
 */
function flushToObservability(): void {
  if (pendingFlush.length === 0) return;
  const batch = pendingFlush.splice(0, auditConfig.dbFlushBatchSize);
  for (const e of batch) {
    observability.logEvent({
      event: "audit",
      companyId: e.companyId,
      category: e.category,
      severity: e.severity,
      eventType: e.eventType,
      summary: e.summary,
      agentRole: toRoleType(e.agentRole),
      agentId: e.agentId,
      beatId: e.beatId,
      detail: e.detail,
      correlationId: e.correlationId,
      causationId: e.causationId,
      sequence: e.sequence,
      ts: Date.parse(e.occurredAt),
    });
  }
}

function startFlushTimer() {
  if (flushTimer || auditConfig.dbFlushIntervalMs <= 0) return;
  flushTimer = setInterval(() => { flushToObservability(); }, auditConfig.dbFlushIntervalMs);
}

function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// ── Public API ─────────────────────────────────────────────

interface AuditAppendInput {
  companyId: string;
  category: AuditCategory;
  severity?: AuditSeverity;
  eventType: string;
  agentId?: string | null;
  agentRole?: string | null;
  summary: string;
  detail?: Record<string, unknown> | null;
  correlationId?: string | null;
  causationId?: string | null;
  beatId?: string | null;
}

/** Append a single audit event. Fast (in-memory), non-blocking DB flush. */
export function audit(input: AuditAppendInput): AuditEvent {
  const severity = input.severity ?? "info";

  // Severity filter
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[auditConfig.severityFilter]) {
    return buildEvent(input, severity); // still return it, just don't store
  }

  // Category filter
  if (auditConfig.categories.length > 0 && !auditConfig.categories.includes(input.category)) {
    return buildEvent(input, severity);
  }

  const event = buildEvent(input, severity);

  // Ring buffer — evict oldest if full
  if (buffer.length >= maxBuffer) {
    buffer.shift();
  }
  buffer.push(event);

  // Queue for DB (capped — drops oldest with a counter so /api/audit/status
  // reflects the dropped events instead of the heap growing unbounded).
  if (pendingFlush.length >= MAX_PENDING_FLUSH) {
    pendingFlush.shift();
    pendingFlushDropped++;
  }
  pendingFlush.push(event);

  // Broadcast to SSE viewers
  broadcast(event);

  // Console output (human-readable)
  printToConsole(event);

  return event;
}

function buildEvent(input: AuditAppendInput, severity: AuditSeverity): AuditEvent {
  return {
    id: randomUUID(),
    companyId: input.companyId,
    sequence: nextSequence(input.companyId),
    category: input.category,
    severity,
    eventType: input.eventType,
    agentId: input.agentId ?? null,
    agentRole: input.agentRole ?? null,
    summary: input.summary,
    detail: input.detail ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    beatId: input.beatId ?? null,
    occurredAt: new Date().toISOString(),
  };
}

/** Convenience: audit an agent action. */
export function auditAgent(
  companyId: string,
  agentRole: string,
  eventType: string,
  summary: string,
  opts?: { agentId?: string; detail?: Record<string, unknown>; severity?: AuditSeverity; correlationId?: string; causationId?: string; beatId?: string }
) {
  return audit({
    companyId,
    category: "agent_action",
    severity: opts?.severity ?? "info",
    eventType,
    agentId: opts?.agentId,
    agentRole,
    summary,
    detail: opts?.detail,
    correlationId: opts?.correlationId,
    causationId: opts?.causationId,
    beatId: opts?.beatId,
  });
}

/** Convenience: audit a system event. */
export function auditSystem(
  companyId: string,
  eventType: string,
  summary: string,
  opts?: { detail?: Record<string, unknown>; severity?: AuditSeverity; correlationId?: string; beatId?: string }
) {
  return audit({
    companyId,
    category: "system",
    severity: opts?.severity ?? "info",
    eventType,
    summary,
    detail: opts?.detail,
    correlationId: opts?.correlationId,
    beatId: opts?.beatId,
  });
}

/** Convenience: audit an error. */
function auditError(
  companyId: string,
  eventType: string,
  summary: string,
  error?: unknown,
  opts?: { agentId?: string; agentRole?: string; correlationId?: string; beatId?: string }
) {
  return audit({
    companyId,
    category: "error",
    severity: "error",
    eventType,
    agentId: opts?.agentId,
    agentRole: opts?.agentRole,
    summary,
    detail: {
      error: error instanceof Error ? { message: error.message, stack: error.stack?.split("\n").slice(0, 5) } : String(error),
    },
    correlationId: opts?.correlationId,
    beatId: opts?.beatId,
  });
}

/** Get recent events from memory (newest last). */
export function getAuditEvents(opts?: {
  limit?: number;
  category?: AuditCategory;
  severity?: AuditSeverity;
  companyId?: string;
  agentRole?: string;
}): AuditEvent[] {
  let result = [...buffer];

  if (opts?.companyId) result = result.filter((e) => e.companyId === opts.companyId);
  if (opts?.category) result = result.filter((e) => e.category === opts.category);
  if (opts?.severity) result = result.filter((e) => SEVERITY_RANK[e.severity] >= SEVERITY_RANK[opts.severity!]);
  if (opts?.agentRole) result = result.filter((e) => e.agentRole === opts.agentRole);

  const limit = opts?.limit ?? auditConfig.logViewerMaxEvents;
  return result.slice(-limit);
}

/** Get audit stats. */
export function getAuditStats() {
  return {
    bufferSize: buffer.length,
    bufferCapacity: maxBuffer,
    pendingFlush: pendingFlush.length,
    pendingFlushCapacity: MAX_PENDING_FLUSH,
    pendingFlushDropped,
    sseSubscribers: subscribers.size,
    sequenceCounters: Object.fromEntries(sequenceCounters),
  };
}

/** Drain all pending writes and stop timers. Call on shutdown. */
export async function drainAuditLedger() {
  stopFlushTimer();
  flushToObservability();
}

/** Start the periodic flush. Call on server startup. */
export function startAuditLedger() {
  startFlushTimer();
  audit({
    companyId: "_system",
    category: "system",
    eventType: "audit_ledger_started",
    summary: `Audit ledger started (buffer=${maxBuffer}, flushInterval=${auditConfig.dbFlushIntervalMs}ms, sink=observability)`,
  });
}

// ── Beat-scoped audit helpers (Spec 12) ────────────────────

/**
 * Returns audit functions pre-bound with a beatId.
 * Use inside a beat executor to tag all events to the current beat.
 */
function withBeatScope(beatId: string) {
  return {
    audit: (input: AuditAppendInput) => audit({ ...input, beatId }),
    auditAgent: (
      companyId: string,
      agentRole: string,
      eventType: string,
      summary: string,
      opts?: Parameters<typeof auditAgent>[4]
    ) => auditAgent(companyId, agentRole, eventType, summary, { ...opts, beatId }),
    auditSystem: (
      companyId: string,
      eventType: string,
      summary: string,
      opts?: Parameters<typeof auditSystem>[3]
    ) => auditSystem(companyId, eventType, summary, { ...opts, beatId }),
    auditError: (
      companyId: string,
      eventType: string,
      summary: string,
      error?: unknown,
      opts?: Parameters<typeof auditError>[4]
    ) => auditError(companyId, eventType, summary, error, { ...opts, beatId }),
  };
}

// ── Console pretty-print ───────────────────────────────────

const SEVERITY_COLORS: Record<AuditSeverity, string> = {
  debug: "\x1b[90m",  // gray
  info:  "\x1b[36m",  // cyan
  warn:  "\x1b[33m",  // yellow
  error: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";

function printToConsole(event: AuditEvent) {
  const color = SEVERITY_COLORS[event.severity];
  const time = event.occurredAt.slice(11, 23); // HH:mm:ss.SSS
  const role = event.agentRole ? ` [${event.agentRole}]` : "";
  const cat = event.category.padEnd(16);
  console.log(`${color}[AUDIT ${time}] ${cat}${role} ${event.summary}${RESET}`);
}
