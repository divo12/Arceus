/**
 * Spec 32 — ArceusEvent union.
 *
 * Discriminated by the `event` tag. Every variant carries correlation IDs
 * (beatId / companyId / sprintId) where applicable so consumers can scope
 * queries without a join. Any field tests might assert against is an enum
 * or an ID — no free-form strings for assertion-critical data.
 *
 * Adding a new variant = PR against this file. Treat the union as a contract.
 */
import { z } from "zod";
import { roleTypeSchema } from "../agents.js";
import { auditCategorySchema, auditSeveritySchema } from "../events.js";

// ── Shared primitives ─────────────────────────────────────────
const tsField = z.number().int().nonnegative(); // epoch ms
const beatIdField = z.string();
const companyIdField = z.string();
const sprintIdField = z.string();
const taskIdField = z.string();
const artifactIdField = z.string();
const approvalIdField = z.string();
const meetingIdField = z.string();
const toolField = z.string();

// ── Event variants ────────────────────────────────────────────
// Each schema below is one discriminated variant; the `event` literal
// is the tag. Order mirrors the lifecycle flow: beat → tool → domain → error.

export const beatStartedSchema = z.object({
  event: z.literal("beat.started"),
  beatId: beatIdField,
  companyId: companyIdField,
  role: roleTypeSchema,
  sprintId: sprintIdField.nullable(),
  trustBand: z.enum(["probation", "standard", "senior"]),
  ts: tsField,
});

/**
 * Emitted right after `beat.started` with a compact summary of what the
 * agent was shown. Useful to diagnose why an LLM picked a particular task
 * id (or hallucinated one).
 */
export const beatContextSchema = z.object({
  event: z.literal("beat.context"),
  beatId: beatIdField,
  role: roleTypeSchema,
  shownTasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    claimable: z.boolean(),
  })),
  ts: tsField,
});

export const beatCompletedSchema = z.object({
  event: z.literal("beat.completed"),
  beatId: beatIdField,
  role: roleTypeSchema,
  durationMs: z.number().nonnegative(),
  verdictOutcome: z.enum(["pass", "fail"]),
  verdictScore: z.number().min(0).max(1),
  ts: tsField,
});

/**
 * Diagnostic counterpart to `beat.completed`: surfaces the raw scoring
 * inputs that produced the verdict. Lets the inspector explain WHY a
 * beat was passed or failed without having to re-run the heuristic by
 * eye against the event log.
 *
 * `branch` records which terminal `if` in scoreBeatVerdict fired so
 * regressions like "idle beats wrongly failed" surface as a single-row
 * diff, not a noisy event re-read.
 */
export const beatScoredSchema = z.object({
  event: z.literal("beat.scored"),
  beatId: beatIdField,
  verdict: z.enum(["pass", "fail"]),
  branch: z.enum([
    "error",
    "real_failure",
    "claimed_without_complete",
    "productive",
    "benign_idle_poll",
    "idle_no_claimable",
    "no_tool_invoked",
    "fallthrough",
  ]),
  toolInvoked: z.number().int().nonnegative(),
  productiveOk: z.boolean(),
  hadError: z.boolean(),
  realFailure: z.boolean(),
  benignIdlePoll: z.boolean(),
  claimedOk: z.boolean(),
  completedOrBlocked: z.boolean(),
  sawBeatContext: z.boolean(),
  shownClaimableCount: z.number().int().nonnegative(),
  ts: tsField,
});

export const beatIdleSchema = z.object({
  event: z.literal("beat.idle"),
  beatId: beatIdField,
  stalledMs: z.number().nonnegative(),
  ts: tsField,
});

export const roleHandoffSchema = z.object({
  event: z.literal("role.handoff"),
  from: roleTypeSchema,
  to: roleTypeSchema,
  reason: z.string(),
  beatId: beatIdField,
  ts: tsField,
});

export const sprintCreatedSchema = z.object({
  event: z.literal("sprint.created"),
  sprintId: sprintIdField,
  companyId: companyIdField,
  goal: z.string(),
  ts: tsField,
});

export const sprintCompletedSchema = z.object({
  event: z.literal("sprint.completed"),
  sprintId: sprintIdField,
  companyId: companyIdField,
  ts: tsField,
});

export const toolInvokedSchema = z.object({
  event: z.literal("tool.invoked"),
  beatId: beatIdField,
  role: roleTypeSchema,
  tool: toolField,
  args: z.unknown(),
  idempotencyKey: z.string().optional(),
  ts: tsField,
});

export const toolResultSchema = z.object({
  event: z.literal("tool.result"),
  beatId: beatIdField,
  tool: toolField,
  ok: z.boolean(),
  cause: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  durationMs: z.number().nonnegative(),
  ts: tsField,
});

export const toolDeniedSchema = z.object({
  event: z.literal("tool.denied"),
  beatId: beatIdField,
  role: roleTypeSchema,
  tool: toolField,
  reason: z.enum(["not_in_allowlist", "role_gate", "governance_block", "circuit_open"]),
  ts: tsField,
});

export const idempotencyReplaySchema = z.object({
  event: z.literal("idempotency.replay"),
  tool: toolField,
  key: z.string(),
  ts: tsField,
});

export const taskCreatedSchema = z.object({
  event: z.literal("task.created"),
  taskId: taskIdField,
  companyId: companyIdField,
  sprintId: sprintIdField.nullable(),
  assignedRole: roleTypeSchema,
  ts: tsField,
});

export const taskUpdatedSchema = z.object({
  event: z.literal("task.updated"),
  taskId: taskIdField,
  companyId: companyIdField,
  patch: z.array(z.string()),
  ts: tsField,
});

export const taskArtifactAttachedSchema = z.object({
  event: z.literal("task.artifact_attached"),
  taskId: taskIdField,
  artifactId: artifactIdField,
  companyId: companyIdField,
  ts: tsField,
});

export const artifactCreatedSchema = z.object({
  event: z.literal("artifact.created"),
  artifactId: artifactIdField,
  companyId: companyIdField,
  kind: z.string(),
  attachedTaskIds: z.array(taskIdField),
  ts: tsField,
});

export const approvalRequestedSchema = z.object({
  event: z.literal("approval.requested"),
  approvalId: approvalIdField,
  companyId: companyIdField,
  kind: z.string(),
  ts: tsField,
});

export const approvalResolvedSchema = z.object({
  event: z.literal("approval.resolved"),
  approvalId: approvalIdField,
  companyId: companyIdField,
  outcome: z.enum(["approved", "rejected"]),
  ts: tsField,
});

export const meetingRecordedSchema = z.object({
  event: z.literal("meeting.recorded"),
  meetingId: meetingIdField,
  companyId: companyIdField,
  participants: z.array(roleTypeSchema),
  ts: tsField,
});

export const meetingContributionSchema = z.object({
  event: z.literal("meeting.contribution"),
  meetingId: meetingIdField,
  companyId: companyIdField,
  artifactId: artifactIdField.optional(),
  position: z.string(),
  ts: tsField,
});

export const memoryWrittenSchema = z.object({
  event: z.literal("memory.written"),
  companyId: companyIdField,
  scope: z.string(),
  sizeBytes: z.number().nonnegative(),
  ts: tsField,
});

export const permissionAskedSchema = z.object({
  event: z.literal("permission.asked"),
  beatId: beatIdField,
  tool: toolField,
  ts: tsField,
});

export const permissionRepliedSchema = z.object({
  event: z.literal("permission.replied"),
  beatId: beatIdField,
  tool: toolField,
  granted: z.boolean(),
  ts: tsField,
});

export const agentReasoningSchema = z.object({
  event: z.literal("agent.reasoning"),
  beatId: beatIdField,
  role: roleTypeSchema,
  text: z.string(),
  ts: tsField,
});

export const errorSchema = z.object({
  event: z.literal("error"),
  where: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  beatId: beatIdField.optional(),
  ts: tsField,
});

/**
 * Legacy audit-ledger compatibility variant.
 *
 * The original `audit-ledger.ts` writer (used in 10+ places across the API for
 * agent_action / task_lifecycle / system / etc.) predates spec 32's typed
 * event union. Rather than migrate every call site, the audit-ledger flush
 * re-emits its buffer through `logEvent` using this variant — single
 * backend, single source of truth, no call-site churn. New code should
 * prefer the typed variants above; this is the escape hatch for legacy
 * free-form data.
 *
 * Category, severity, and role reuse existing schemas verbatim — no
 * duplicated string unions, no coercion. A legacy AuditEvent passes
 * through with `agentRole` validated via `roleTypeSchema.safeParse` at
 * the call site (legacy stored it as free-form string, our union demands
 * a typed role).
 */
export const auditSchema = z.object({
  event: z.literal("audit"),
  companyId: companyIdField,
  category: auditCategorySchema,
  severity: auditSeveritySchema,
  eventType: z.string(),
  summary: z.string(),
  agentRole: roleTypeSchema.nullable(),
  agentId: z.string().nullable(),
  beatId: beatIdField.nullable(),
  detail: z.unknown().nullable(),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  ts: tsField,
});

/**
 * Dual-write failure — emitted when the in-memory store mirrors to Postgres
 * and the upsert throws (FK violation, check constraint, …). Without this
 * event the failure is invisible in the inspector and the next CAS-only
 * consumer (e.g. `task_claim`) appears to fail with `not_found` for no
 * obvious reason. The pg SQLSTATE is the discriminator: 23503 = FK,
 * 23502 = NOT NULL, 23514 = check, 42703 = column missing, 23505 = unique.
 */
export const persistFailedSchema = z.object({
  event: z.literal("persist.failed"),
  table: z.string(),
  id: z.string(),
  pgCode: z.string(),
  ts: tsField,
});

// ── Union ─────────────────────────────────────────────────────

export const arceusEventSchema = z.discriminatedUnion("event", [
  beatStartedSchema,
  beatContextSchema,
  beatCompletedSchema,
  beatScoredSchema,
  beatIdleSchema,
  roleHandoffSchema,
  sprintCreatedSchema,
  sprintCompletedSchema,
  toolInvokedSchema,
  toolResultSchema,
  toolDeniedSchema,
  idempotencyReplaySchema,
  taskCreatedSchema,
  taskUpdatedSchema,
  taskArtifactAttachedSchema,
  artifactCreatedSchema,
  approvalRequestedSchema,
  approvalResolvedSchema,
  meetingRecordedSchema,
  meetingContributionSchema,
  memoryWrittenSchema,
  permissionAskedSchema,
  permissionRepliedSchema,
  agentReasoningSchema,
  errorSchema,
  auditSchema,
  persistFailedSchema,
]);

export type ArceusEvent = z.infer<typeof arceusEventSchema>;

/** Narrow an untyped record to `ArceusEvent` or return null (does not throw). */
export function parseEvent(input: unknown): ArceusEvent | null {
  const result = arceusEventSchema.safeParse(input);
  return result.success ? result.data : null;
}
