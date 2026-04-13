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

// ── Control Plane types (Spec 11 Phase 2) ──────────────────

export const stateMutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task_status"),     taskId: z.string(), status: z.string(), summary: z.string().optional() }),
  z.object({ type: z.literal("task_assign"),      taskId: z.string(), agentId: z.string() }),
  z.object({ type: z.literal("task_create"),      task: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("sprint_status"),    sprintId: z.string(), status: z.string() }),
  z.object({ type: z.literal("sprint_create"),    sprint: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("meeting_record"),   meeting: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("approval_create"),  approval: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("approval_resolve"), approvalId: z.string(), status: z.enum(["approved", "rejected"]), summary: z.string() }),
  z.object({ type: z.literal("chat_message"),     message: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("agent_status"),     agentId: z.string(), status: z.string() }),
  z.object({ type: z.literal("company_status"),   status: z.string() }),
  z.object({ type: z.literal("transition_append"), transition: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("transition_update"), transitionId: z.string(), changes: z.record(z.string(), z.unknown()) }),
]);

export type StateMutation = z.infer<typeof stateMutationSchema>;

/** Summary of a snapshot version checkpoint */
export const snapshotVersionSchema = z.object({
  companyId: z.string(),
  version: z.number().int(),
  updatedAt: z.string(),
  mutationCount: z.number().int(),
});

export type SnapshotVersion = z.infer<typeof snapshotVersionSchema>;
