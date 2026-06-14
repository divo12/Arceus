import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z, ZodError, type ZodSchema } from "zod";
import type { AgentIdentity, Meeting, RoleType, Task } from "@arceus/contracts";
import { observability, parseRole, parseRoleStrict } from "@arceus/contracts";
import { recordMeeting } from "../../meetings/recording.js";
import { writeMeetingSync } from "../../persistence/mutations/index.js";
import { upsertMeeting } from "../../persistence/mutations/index.js";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { failure, success, type ErrorCause } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";
import { getMeetingPipelineRunner } from "../../orchestration/state.js";
import { trackChatMeetingRequest, takeChatMeetingRequest } from "../../agents/chat-meeting-tracker.js";
import { swallowAndAudit } from "../../observability/swallow.js";
import { appendChatMessage } from "../../persistence/mutations/index.js";
import { publishChatEvent } from "../../agents/chat-events.js";
import { getDb } from "@arceus/db";
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";

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
      companyId: req.mcp!.companyId,
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
        companyId: mcp.companyId,
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

  // ── Spec 35 §5 — async "let me check with the team" ───────────
  app.post(`${MEETINGS_BASE}/request`, async (req, reply) => {
    const requestBody = z.object({
      topic: z.string().min(1).max(200),
      attendees: z.array(z.string().min(1)).min(1).max(8),
      question: z.string().min(1).max(4000),
    });
    const body = parseOrFail(requestBody, req.body, reply);
    if (!body) return reply;

    const mcp = req.mcp!;
    if (mcp.role !== "ceo") {
      return reply.code(403).send(
        failure("meeting_request is CEO-only.", "governance", "never", "role_correct"),
      );
    }

    const snap = await buildSnapshotView(mcp.companyId);
    if (snap.agents.length === 0) {
      return reply.code(409).send(
        failure(
          "Cannot schedule a team meeting before the company has agents. Hire the team first.",
          "conflict",
          "unsafe",
          "agents_exist",
        ),
      );
    }

    // Resolve attendee roles → real agent IDs. Unknown roles are dropped
    // (CEO may have hallucinated a role); we keep going if at least one
    // resolves so the user still gets a meeting.
    const facilitator = snap.agents.find((a) => a.role === "ceo") ?? snap.agents[0];
    const participantIds: string[] = [];
    const resolvedRoles: string[] = [];
    const unresolvedRoles: string[] = [];
    for (const role of body.attendees) {
      const agent = snap.agents.find((a) => a.role === role);
      if (agent && !participantIds.includes(agent.id)) {
        participantIds.push(agent.id);
        resolvedRoles.push(role);
      } else if (!agent) {
        unresolvedRoles.push(role);
      }
    }
    // Always include the facilitator (CEO) so the meeting has a known
    // host.
    if (!participantIds.includes(facilitator.id)) {
      participantIds.push(facilitator.id);
    }
    if (resolvedRoles.length === 0) {
      return reply.code(409).send(
        failure(
          `None of the requested roles exist on this team: ${body.attendees.join(", ")}.`,
          "conflict",
          "unsafe",
          "roles_exist",
        ),
      );
    }

    const now = new Date().toISOString();
    const meetingId = `meeting_${randomUUID()}`;
    const meeting: Meeting = {
      id: meetingId,
      companyId: mcp.companyId,
      scheduleId: null,
      type: "eval_triggered",
      title: `Avery asked the team: ${body.topic}`,
      status: "scheduled",
      facilitatorAgentId: facilitator.id,
      participantAgentIds: participantIds,
      contributions: [],
      synthesis: null,
      resolutions: null,
      brief: null,
      healthSnapshot: null,
      createdAt: now,
      completedAt: null,
    };

    await upsertMeeting(meeting);

    // Find the most recent user board message — that's the "requested by"
    // message id for cards/threading. Best-effort.
    let requestedByChatMessageId: string | null = null;
    try {
      const recent = await boardMessagesRepo.listBoardMessages(getDb(), mcp.companyId, 20);
      const userMsg = recent.find((r) => r.role === "board");
      requestedByChatMessageId = userMsg?.id ?? null;
    } catch { /* non-fatal */ }

    trackChatMeetingRequest(meetingId, {
      companyId: mcp.companyId,
      requestedByChatMessageId,
      topic: body.topic,
      question: body.question,
      attendees: resolvedRoles,
    });

    const runner = getMeetingPipelineRunner();
    if (!runner) {
      return reply.code(503).send(
        failure("Meeting pipeline runner not initialized.", "upstream", "safe", "system_recovered"),
      );
    }

    // Fire-and-forget pipeline. When it completes, emit a meeting_summary card.
    swallowAndAudit("chat.meeting_request_pipeline", async () => {
      try {
        await runner(meetingId);
      } finally {
        const tracked = takeChatMeetingRequest(meetingId);
        if (tracked) {
          // Re-read the meeting to get the synthesized brief / decisions.
          const completed = await buildSnapshotView(tracked.companyId);
          const m = completed.meetings.find((x) => x.id === meetingId);
          const summaryText = m?.brief?.teamUpdates?.map((u) => `${u.agentRole}: ${u.summary}`).join("; ")
            ?? m?.synthesis?.highlights?.join("; ")
            ?? "Meeting complete — see Meetings tab for transcript.";
          const decisionsList = m?.resolutions?.decisions?.map((d) => d.decision) ?? [];

          const cardMessage = await appendChatMessage({
            id: `chat_${randomUUID()}`,
            companyId: tracked.companyId,
            sprintId: completed.company.currentSprintId,
            agentId: null,
            role: "ceo",
            content: "",
            cardType: "meeting_summary",
            cardData: {
              type: "meeting_summary",
              meetingId,
              topic: tracked.topic,
              question: tracked.question,
              attendees: tracked.attendees,
              summary: summaryText,
              decisions: decisionsList,
              status: m?.status ?? "completed",
            },
            createdAt: new Date().toISOString(),
            mode: null,
            parentMessageId: tracked.requestedByChatMessageId,
            cardDecision: null,
            cardDecidedAt: null,
            cardDecidedBy: null,
          });
          publishChatEvent({ type: "chat.card_added", companyId: tracked.companyId, message: cardMessage });
        }
      }
    }, { detail: { meetingId, kind: "chat_meeting_request" } });

    return cacheAndSend(
      req,
      reply,
      201,
      success(
        `Meeting ${meetingId} scheduled with ${resolvedRoles.join(", ")}.`,
        {
          meetingId,
          attendees: resolvedRoles,
          unresolvedAttendees: unresolvedRoles,
          status: "scheduled",
        },
      ),
      `${MEETINGS_BASE}/${meetingId}`,
    );
  });
}
