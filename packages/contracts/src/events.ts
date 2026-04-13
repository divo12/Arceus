import { z } from "zod";

export const actorTypeSchema = z.enum(["board", "agent", "system", "runtime"]);

export const eventEnvelopeSchema = z.object({
  eventId: z.string(),
  companyId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  eventType: z.string(),
  causationId: z.string().nullable(),
  correlationId: z.string(),
  actorType: actorTypeSchema,
  actorId: z.string(),
  occurredAt: z.string(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown())
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

// ── Audit Ledger (Spec 11) ─────────────────────────────────

export const auditCategorySchema = z.enum([
  "agent_action",     // agent tool calls, task work
  "task_lifecycle",   // task created, started, completed, failed
  "sprint_lifecycle", // sprint planning, executing, completed
  "system",           // orchestrator state, heartbeat, startup/shutdown
  "board",            // board messages, approvals, strategy
  "policy_eval",      // governance gateway decisions (Spec 13)
  "error",            // errors and failures
]);

export const auditSeveritySchema = z.enum(["debug", "info", "warn", "error"]);

export const auditEventSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sequence: z.number().int(),              // per-company monotonic counter
  category: auditCategorySchema,
  severity: auditSeveritySchema,
  eventType: z.string(),                   // e.g. "task_started", "tool_invoked", "sprint_completed"
  agentId: z.string().nullable(),
  agentRole: z.string().nullable(),
  summary: z.string(),                     // human-readable one-liner
  detail: z.record(z.string(), z.unknown()).nullable(),  // structured payload
  correlationId: z.string().nullable(),    // links related events (e.g. same task)
  causationId: z.string().nullable(),      // what triggered this event
  occurredAt: z.string(),                  // ISO timestamp
});

export type AuditCategory = z.infer<typeof auditCategorySchema>;
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
