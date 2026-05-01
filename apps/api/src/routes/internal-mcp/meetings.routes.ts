import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z, ZodError, type ZodSchema } from "zod";
import type { AgentIdentity, Meeting, RoleType, Task } from "@arceus/contracts";
import { observability, parseRole, parseRoleStrict } from "@arceus/contracts";
import { recordMeeting } from "../../meetings/recording.js";
import { writeMeetingSync } from "../../persistence/mutations/index.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";

const MEETINGS_BASE = "/api/internal/v1/meetings";

const zodDetails = (err: ZodError) =>
  err.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const sendValidation = (reply: FastifyReply, err: ZodError): FastifyReply => {
  return reply.code(422).send({
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
): FastifyReply => {
  if (locationHeader) void reply.header("location", locationHeader);
  cacheSuccessfulResponse(req, { status, body, locationHeader: locationHeader ?? null });
  return reply.code(status).send(body);
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
    if (!body) return reply;

    const recorded: Meeting = await recordMeeting({
      type: body.type,
      facilitatorRole: parseRoleStrict(body.facilitatorRole),
      participantRoles: body.participantRoles.map((r) => parseRoleStrict(r)),
      summary: body.summary,
      agenda: body.agenda.map((item) => ({
        topic: item.topic,
        type: item.type,
        content: item.content,
        raisedByRole: parseRoleStrict(item.raisedByRole),
        relatedTaskId: item.relatedTaskId ?? null,
        needsBoardApproval: item.needsBoardApproval,
      })),
      decisions: body.decisions?.map((d) => ({
        description: d.description,
        decidedByRoles: d.decidedByRoles.map((r) => parseRoleStrict(r)),
        impactIds: d.impactIds ?? [],
      })),
      learnings: body.learnings?.map((l) => ({
        role: parseRoleStrict(l.role),
        content: l.content,
        promotedToSummary: l.promotedToSummary,
      })),
      taskModifications: body.taskModifications?.map((m) => ({
        taskId: m.taskId,
        modificationType: m.modificationType,
        details: m.details,
        assignedRole: m.assignedRole != null ? parseRole(m.assignedRole) : null,
        priority: (m.priority ?? null),
        resultingStatus: (m.resultingStatus ?? null),
      })),
      memoryModifications: body.memoryModifications?.map((m) => ({
        role: parseRoleStrict(m.role),
        modificationType: m.modificationType,
        content: m.content,
      })),
    });

    // Spec 28 Phase B.1 — flush snapshot to DB before returning.
    const meeting = await writeMeetingSync(recorded);

    observability.logEvent({
      event: "meeting.recorded",
      meetingId: meeting.id,
      companyId: req.mcp!.companyId,
      participants: body.participantRoles.map((r) => parseRoleStrict(r)),
      ts: Date.now(),
    });

    const location = `${MEETINGS_BASE}/${meeting.id}`;
    return cacheAndSend(
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

  // GET /meetings/:meetingId — read a single meeting
  app.get<{ Params: { meetingId: string } }>(
    `${MEETINGS_BASE}/:meetingId`,
    async (req, reply) => {
      const { meetingId } = req.params;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const meeting = snapshot.meetings?.find((m) => m.id === meetingId);
      if (!meeting) {
        return reply.code(404).send(failure(`Meeting ${meetingId} not found.`, "not_found", "never", "meeting_exists"));
        return;
      }
      return cacheAndSend(req, reply, 200, success(`Meeting ${meetingId}.`, { meeting }));
    },
  );

  // POST /meetings/request-decision — open an async decision meeting
  app.post(
    `${MEETINGS_BASE}/request-decision`,
    async (req, reply) => {
      const requestDecisionBody = z.object({
        topic: z.string().min(1).max(200),
        description: z.string().min(1).max(4000),
        participantRoles: z.array(z.string()).min(1).max(8),
        deadline: z.string().optional(),
      });
      const body = parseOrFail(requestDecisionBody, req.body, reply);
      if (!body) return reply;

      const mcp = req.mcp!;
      const meetingId = `mtg_${randomUUID().slice(0, 12)}`;
      const now = new Date().toISOString();

      // Record the meeting shell with status "open"
      const recordedDecision: Meeting = await recordMeeting({
        type: "escalation",
        facilitatorRole: parseRoleStrict(mcp.role),
        participantRoles: body.participantRoles.map((r) => parseRoleStrict(r)),
        summary: `Decision requested: ${body.topic}`,
        agenda: [{
          topic: body.topic,
          type: "proposal",
          content: body.description,
          raisedByRole: parseRoleStrict(mcp.role),
          relatedTaskId: null,
        }],
        decisions: [],
        learnings: [],
        taskModifications: [],
        memoryModifications: [],
      });

      // Spec 28 Phase B.1 — flush snapshot to DB before returning.
      const meeting = await writeMeetingSync(recordedDecision);

      return cacheAndSend(
        req,
        reply,
        201,
        success(`Decision meeting ${meeting.id} created.`, {
          meetingId: meeting.id,
          topic: body.topic,
          participantRoles: body.participantRoles,
          status: "open",
        }),
        `${MEETINGS_BASE}/${meeting.id}`,
      );
    },
  );

  // POST /meetings/:meetingId/contribute — attach a position/artifact to an open meeting
  app.post<{ Params: { meetingId: string } }>(
    `${MEETINGS_BASE}/:meetingId/contribute`,
    async (req, reply) => {
      const contributeBody = z.object({
        artifactId: z.string().min(1),
        position: z.string().max(2000).optional(),
      });
      const body = parseOrFail(contributeBody, req.body, reply);
      if (!body) return reply;

      const { meetingId } = req.params;
      const snapshot = await buildSnapshotView(req.mcp!.companyId);
      const meeting = snapshot.meetings?.find((m) => m.id === meetingId);
      if (!meeting) {
        return reply.code(404).send(failure(`Meeting ${meetingId} not found.`, "not_found", "never", "meeting_exists"));
        return;
      }

      const mcp = req.mcp!;

      // Build the updated meeting (immutable update so writeMeetingSync sees a fresh ref)
      const updated: Meeting = {
        ...meeting,
        contributions: [
          ...meeting.contributions,
          {
            agentId: `agent_${mcp.role}`,
            agentName: mcp.role,
            agentRole: mcp.role,
            contribution: {
              whatIDid: body.position ?? `Contributed artifact ${body.artifactId}`,
              whatImDoing: "",
              blockers: "",
              learnings: "",
              questionsForTeam: "",
            },
            submittedAt: new Date().toISOString(),
          },
        ],
      };

      // Spec 28 Phase B.1 — durable upsert + flush.
      await writeMeetingSync(updated);

      return cacheAndSend(req, reply, 200, success(`Contribution added to meeting ${meetingId}.`, {
        meetingId,
        artifactId: body.artifactId,
        contributedBy: mcp.role,
      }));
    },
  );
}
