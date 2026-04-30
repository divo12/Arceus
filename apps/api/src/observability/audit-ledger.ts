/**
 * Audit shim — Spec 11 / Spec 32 Option A.
 *
 * Producers call `audit({...})`, `auditAgent(...)`, or `auditSystem(...)`.
 * Each call stamps a per-company sequence number and emits a single
 * `event: "audit"` ArceusEvent through `observability.logEvent`. From
 * there the multi-sink fans out to pino, langfuse, eventBus,
 * activity_log, and `auditViewSink` (the ring + SSE that backs
 * `/api/audit/{events,stats,stream}`).
 *
 * No ring, no SSE, no console formatter, no batched flush — those
 * live in their respective sinks now. This file is purely the
 * producer-side ergonomics + sequence stamping.
 */
import type { AuditCategory, AuditSeverity } from "@arceus/contracts";
import { observability, roleTypeSchema, type RoleType } from "@arceus/contracts";

const sequenceCounters = new Map<string, number>();

function nextSequence(companyId: string): number {
  const next = (sequenceCounters.get(companyId) ?? 0) + 1;
  sequenceCounters.set(companyId, next);
  return next;
}

function toRoleType(role: string | null | undefined): RoleType | null {
  if (!role) return null;
  const parsed = roleTypeSchema.safeParse(role);
  return parsed.success ? parsed.data : null;
}

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

/** Append a single audit event. Fire-and-forget; never throws. */
export function audit(input: AuditAppendInput): void {
  observability.logEvent({
    event: "audit",
    companyId: input.companyId,
    category: input.category,
    severity: input.severity ?? "info",
    eventType: input.eventType,
    summary: input.summary,
    agentRole: toRoleType(input.agentRole),
    agentId: input.agentId ?? null,
    beatId: input.beatId ?? null,
    detail: input.detail ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    sequence: nextSequence(input.companyId),
    ts: Date.now(),
  });
}

/** Convenience: audit an agent action. */
export function auditAgent(
  companyId: string,
  agentRole: string,
  eventType: string,
  summary: string,
  opts?: { agentId?: string; detail?: Record<string, unknown>; severity?: AuditSeverity; correlationId?: string; causationId?: string; beatId?: string }
): void {
  audit({
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
): void {
  audit({
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
