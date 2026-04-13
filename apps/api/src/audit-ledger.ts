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
import { isDatabaseConfigured, getDb } from "@arceus/db";
import { auditEventsTable } from "@arceus/db";
import { auditConfig } from "./config/audit";

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

export function subscribeSse(writer: SseWriter) {
  subscribers.add(writer);
  return () => { subscribers.delete(writer); };
}

function broadcast(event: AuditEvent) {
  for (const writer of subscribers) {
    try { writer(event); } catch { subscribers.delete(writer); }
  }
}

// ── DB flush queue ─────────────────────────────────────────

let pendingFlush: AuditEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveDbFailures = 0;
const MAX_DB_FAILURES = 3;
let dbFlushDisabled = false;

async function flushToDb() {
  if (pendingFlush.length === 0) return;
  if (!auditConfig.dbEnabled || !isDatabaseConfigured()) {
    // DB not configured — silently discard pending writes (events live in memory)
    pendingFlush.length = 0;
    return;
  }
  if (dbFlushDisabled) return;

  const batch = pendingFlush.splice(0, auditConfig.dbFlushBatchSize);
  try {
    const db = getDb();
    await db.insert(auditEventsTable).values(
      batch.map((e) => ({
        id: e.id,
        companyId: e.companyId,
        sequence: e.sequence,
        category: e.category,
        severity: e.severity,
        eventType: e.eventType,
        agentId: e.agentId,
        agentRole: e.agentRole,
        summary: e.summary,
        detail: e.detail,
        correlationId: e.correlationId,
        causationId: e.causationId,
        occurredAt: new Date(e.occurredAt),
      }))
    );
    // Reset failure counter on success
    if (consecutiveDbFailures > 0) {
      console.log("[AUDIT] DB flush recovered after", consecutiveDbFailures, "failures");
      consecutiveDbFailures = 0;
    }
  } catch (err) {
    consecutiveDbFailures++;
    if (consecutiveDbFailures >= MAX_DB_FAILURES) {
      // Stop retrying — events are safe in the in-memory ring buffer
      dbFlushDisabled = true;
      pendingFlush.length = 0; // discard pending queue
      console.warn(`[AUDIT] DB flush disabled after ${MAX_DB_FAILURES} consecutive failures. Events remain in memory. Last error: ${err instanceof Error ? err.message : err}`);
    } else {
      // Retry next interval — put batch back
      console.warn(`[AUDIT] DB flush failed (attempt ${consecutiveDbFailures}/${MAX_DB_FAILURES}), will retry: ${err instanceof Error ? err.message : err}`);
      pendingFlush.unshift(...batch);
    }
  }
}

function startFlushTimer() {
  if (flushTimer || auditConfig.dbFlushIntervalMs <= 0) return;
  flushTimer = setInterval(() => { flushToDb(); }, auditConfig.dbFlushIntervalMs);
}

function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// ── Public API ─────────────────────────────────────────────

export interface AuditAppendInput {
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

  // Queue for DB
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
    occurredAt: new Date().toISOString(),
  };
}

/** Convenience: audit an agent action. */
export function auditAgent(
  companyId: string,
  agentRole: string,
  eventType: string,
  summary: string,
  opts?: { agentId?: string; detail?: Record<string, unknown>; severity?: AuditSeverity; correlationId?: string; causationId?: string }
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
  });
}

/** Convenience: audit a system event. */
export function auditSystem(
  companyId: string,
  eventType: string,
  summary: string,
  opts?: { detail?: Record<string, unknown>; severity?: AuditSeverity; correlationId?: string }
) {
  return audit({
    companyId,
    category: "system",
    severity: opts?.severity ?? "info",
    eventType,
    summary,
    detail: opts?.detail,
    correlationId: opts?.correlationId,
  });
}

/** Convenience: audit an error. */
export function auditError(
  companyId: string,
  eventType: string,
  summary: string,
  error?: unknown,
  opts?: { agentId?: string; agentRole?: string; correlationId?: string }
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
    pendingDbFlush: pendingFlush.length,
    dbEnabled: auditConfig.dbEnabled && isDatabaseConfigured() && !dbFlushDisabled,
    dbFlushDisabled,
    sseSubscribers: subscribers.size,
    sequenceCounters: Object.fromEntries(sequenceCounters),
  };
}

/** Drain all pending writes and stop timers. Call on shutdown. */
export async function drainAuditLedger() {
  stopFlushTimer();
  await flushToDb();
}

/** Start the periodic DB flush. Call on server startup. */
export function startAuditLedger() {
  startFlushTimer();
  audit({
    companyId: "_system",
    category: "system",
    eventType: "audit_ledger_started",
    summary: `Audit ledger started (buffer=${maxBuffer}, dbFlush=${auditConfig.dbFlushIntervalMs}ms, db=${auditConfig.dbEnabled && isDatabaseConfigured() ? "ON" : "OFF"})`,
  });
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
