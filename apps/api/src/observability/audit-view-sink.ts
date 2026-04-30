/**
 * Audit view sink — Spec 11 / Spec 32 Option A.
 *
 * The audit firehose lives in `observability.logEvent` (single emit point).
 * This sink subscribes to the audit variant only, builds the legacy
 * `AuditEvent` shape that TUI consumers expect, and serves three reads:
 *   - `/api/audit/events` — paginated history from the ring
 *   - `/api/audit/stats`  — health/health-of-ring + subscriber count
 *   - `/api/audit/stream` — live SSE
 *
 * Severity + category filtering happens HERE (not in the shim) so that
 * pino, langfuse, eventBus, and activity_log still see every audit event
 * even when the audit ring is configured to drop low-severity noise.
 */
import { randomUUID } from "node:crypto";
import type { AuditCategory, AuditEvent, AuditSeverity, ArceusEvent } from "@arceus/contracts";
import type { observability } from "@arceus/contracts";

type EventSink = observability.EventSink;
import { auditConfig } from "../config/audit.js";

const SEVERITY_RANK: Record<AuditSeverity, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const buffer: AuditEvent[] = [];
const maxBuffer = auditConfig.memoryBufferSize;

type SseWriter = (event: AuditEvent) => void;
const subscribers = new Set<SseWriter>();

function isAuditVariant(e: ArceusEvent): boolean {
  return e.event === "audit";
}

function arceusEventToAuditEvent(e: ArceusEvent & { event: "audit" }): AuditEvent {
  return {
    id: randomUUID(),
    companyId: e.companyId,
    sequence: e.sequence,
    category: e.category,
    severity: e.severity,
    eventType: e.eventType,
    agentId: e.agentId,
    agentRole: e.agentRole,
    summary: e.summary,
    detail: (e.detail as AuditEvent["detail"]) ?? null,
    correlationId: e.correlationId,
    causationId: e.causationId,
    beatId: e.beatId,
    occurredAt: new Date(e.ts).toISOString(),
  };
}

function passesFilter(severity: AuditSeverity, category: AuditCategory): boolean {
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[auditConfig.severityFilter]) return false;
  if (auditConfig.categories.length > 0 && !auditConfig.categories.includes(category)) return false;
  return true;
}

function broadcast(event: AuditEvent): void {
  for (const writer of subscribers) {
    try { writer(event); } catch { subscribers.delete(writer); }
  }
}

export const auditViewSink: EventSink = {
  write(e: ArceusEvent): void {
    if (!isAuditVariant(e)) return;
    const audit = e as ArceusEvent & { event: "audit" };
    if (!passesFilter(audit.severity, audit.category)) return;

    const event = arceusEventToAuditEvent(audit);

    if (buffer.length >= maxBuffer) buffer.shift();
    buffer.push(event);

    broadcast(event);
  },
};

/** Subscribe an SSE writer to receive live audit events. Returns an unsubscribe function. */
export function subscribeSse(writer: SseWriter) {
  subscribers.add(writer);
  return () => { subscribers.delete(writer); };
}

/** Get recent events from the ring (newest last). */
export function getAuditEvents(opts?: {
  limit?: number;
  category?: AuditCategory;
  severity?: AuditSeverity;
  companyId?: string;
  agentRole?: string;
}): AuditEvent[] {
  let result: AuditEvent[] = [...buffer];

  if (opts?.companyId) result = result.filter((e) => e.companyId === opts.companyId);
  if (opts?.category) result = result.filter((e) => e.category === opts.category);
  if (opts?.severity) result = result.filter((e) => SEVERITY_RANK[e.severity] >= SEVERITY_RANK[opts.severity!]);
  if (opts?.agentRole) result = result.filter((e) => e.agentRole === opts.agentRole);

  const limit = opts?.limit ?? auditConfig.logViewerMaxEvents;
  return result.slice(-limit);
}

/** Get audit ring + SSE health. */
export function getAuditStats() {
  return {
    bufferSize: buffer.length,
    bufferCapacity: maxBuffer,
    sseSubscribers: subscribers.size,
  };
}
