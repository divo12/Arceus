import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodSchema } from "zod";
import type { AgentIdentity, Meeting, Task } from "@arceus/contracts";
import { recordMeeting } from "../../meetings/recording.js";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const MEETINGS_BASE = "/api/internal/v1/meetings";

const zodDetails = (err: ZodError) =>
  err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const sendValidation = (reply: FastifyReply, err: ZodError): void => {
  reply.code(422).send({
    ...failure("Request validation failed.", "validation", "never", "payload_fixed"),
    error: {
      cause: "validation" as ErrorCause,
      retry: "never" as const,
      stopWhen: "payload_fixed",
      details: zodDetails(err),
    },
  });
};

const parseOrFail = <T>(schema: ZodSchema<T>, body: unknown, reply: FastifyReply): T | null => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendValidation(reply, parsed.error);
    return null;
  }
  return parsed.data;
};

const cacheAndSend = (
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: unknown,
  locationHeader?: string | null,
): void => {
  if (locationHeader) void reply.header("location", locationHeader);
  cacheSuccessfulResponse(req, { status, body, locationHeader: locationHeader ?? null });
  reply.code(status).send(body);
};

// ── Schemas ──────────────────────────────────────────────

const meetingType = z.enum(["daily_sync", "eval_triggered", "escalation"]);
const agendaType = z.enum(["update", "blocker", "question", "proposal"]);
const role = z.string().min(1).max(64);
const taskPriority = z.enum(["low", "medium", "high", "critical"]);
const taskStatus = z.enum([
  "created",
  "planned",
  "in_progress",
  "verifying",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
const modificationType = z.enum([
  "assign",
  "reprioritize",
  "reassign",
  "cancel",
  "decompose_further",
  "unblock",
]);
const memoryModificationType = z.enum([
  "current_focus",
  "recent_learning",
  "active_pattern",
  "open_blocker",
  "important_decision",
  "clear_blocker",
]);

const agendaItem = z.object({
  topic: z.string().min(1).max(200),
  type: agendaType,
  content: z.string().min(1).max(4000),
  raisedByRole: role,
  relatedTaskId: z.string().nullable().optional(),
  needsBoardApproval: z.boolean().optional(),
});

const decisionItem = z.object({
  description: z.string().min(1).max(2000),
  decidedByRoles: z.array(role).min(1),
  impactIds: z.array(z.string()).default([]),
});

const learningItem = z.object({
  role,
  content: z.string().min(1).max(2000),
  promotedToSummary: z.boolean().optional(),
});

const taskModificationItem = z.object({
  taskId: z.string().min(1),
  modificationType,
  details: z.string().min(1).max(2000),
  assignedRole: role.nullable().optional(),
  priority: taskPriority.nullable().optional(),
  resultingStatus: taskStatus.nullable().optional(),
});

const memoryModificationItem = z.object({
  role,
  modificationType: memoryModificationType,
  content: z.string().min(1).max(2000),
});

const createMeetingBody = z.object({
  type: meetingType,
  facilitatorRole: role,
  participantRoles: z.array(role).min(1).max(16),
  summary: z.string().min(1).max(500),
  agenda: z.array(agendaItem).min(1).max(32),
  decisions: z.array(decisionItem).optional(),
  learnings: z.array(learningItem).optional(),
  taskModifications: z.array(taskModificationItem).optional(),
  memoryModifications: z.array(memoryModificationItem).optional(),
});

// ── Routes ───────────────────────────────────────────────

export default async function internalMcpMeetingsRoutes(app: FastifyInstance): Promise<void> {
  app.post(MEETINGS_BASE, async (req, reply) => {
    const body = parseOrFail(createMeetingBody, req.body, reply);
    if (!body) return;

    const meeting: Meeting = recordMeeting({
      type: body.type,
      facilitatorRole: body.facilitatorRole as AgentIdentity["role"],
      participantRoles: body.participantRoles as AgentIdentity["role"][],
      summary: body.summary,
      agenda: body.agenda.map((item) => ({
        topic: item.topic,
        type: item.type,
        content: item.content,
        raisedByRole: item.raisedByRole as AgentIdentity["role"],
        relatedTaskId: item.relatedTaskId ?? null,
        needsBoardApproval: item.needsBoardApproval,
      })),
      decisions: body.decisions?.map((d) => ({
        description: d.description,
        decidedByRoles: d.decidedByRoles as AgentIdentity["role"][],
        impactIds: d.impactIds ?? [],
      })),
      learnings: body.learnings?.map((l) => ({
        role: l.role as AgentIdentity["role"],
        content: l.content,
        promotedToSummary: l.promotedToSummary,
      })),
      taskModifications: body.taskModifications?.map((m) => ({
        taskId: m.taskId,
        modificationType: m.modificationType,
        details: m.details,
        assignedRole: (m.assignedRole ?? null) as AgentIdentity["role"] | null,
        priority: (m.priority ?? null) as Task["priority"] | null,
        resultingStatus: (m.resultingStatus ?? null) as Task["status"] | null,
      })),
      memoryModifications: body.memoryModifications?.map((m) => ({
        role: m.role as AgentIdentity["role"],
        modificationType: m.modificationType,
        content: m.content,
      })),
    });

    const location = `${MEETINGS_BASE}/${meeting.id}`;
    cacheAndSend(
      req,
      reply,
      201,
      success(`Meeting ${meeting.id} recorded.`, {
        meetingId: meeting.id,
        type: meeting.type,
        participantCount: meeting.participantAgentIds.length,
      }),
      location,
    );
  });
}
