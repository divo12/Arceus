import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, meetings, meetingEvents, meetingParticipants } from "@paperclipai/db";
import type {
  CreateMeeting,
  UpdateMeeting,
  AddMeetingEvent,
  CreateEscalationMeeting,
  Meeting,
  MeetingDetail,
  MeetingListItem,
  MeetingParticipant,
  MeetingParticipantContribution,
  MeetingEvent,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

type Actor = { agentId?: string | null; userId?: string | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMeeting(row: typeof meetings.$inferSelect): Meeting {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as Meeting["type"],
    status: row.status as Meeting["status"],
    title: row.title,
    description: row.description,
    agenda: row.agenda as Meeting["agenda"],
    scheduledAt: row.scheduledAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    linkedIssueId: row.linkedIssueId,
    linkedRoutineId: row.linkedRoutineId,
    initiatedByAgentId: row.initiatedByAgentId,
    initiatedByUserId: row.initiatedByUserId,
    meetingNotes: row.meetingNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toParticipant(
  row: typeof meetingParticipants.$inferSelect,
  agent?: { name: string; role: string | null } | null,
): MeetingParticipant {
  return {
    id: row.id,
    companyId: row.companyId,
    meetingId: row.meetingId,
    agentId: row.agentId,
    role: row.role as MeetingParticipant["role"],
    joinedAt: row.joinedAt,
    contribution: row.contribution as MeetingParticipantContribution | null,
    createdAt: row.createdAt,
    agentName: agent?.name,
    agentRole: agent?.role ?? undefined,
  };
}

function toEvent(
  row: typeof meetingEvents.$inferSelect,
  agent?: { name: string; role: string | null } | null,
): MeetingEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    meetingId: row.meetingId,
    seq: row.seq,
    kind: row.kind as MeetingEvent["kind"],
    agentId: row.agentId,
    content: row.content,
    payload: row.payload as Record<string, unknown> | null,
    createdAt: row.createdAt,
    agentName: agent?.name,
    agentRole: agent?.role ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function meetingService(db: Db) {
  // ------- Read -------

  async function get(meetingId: string): Promise<Meeting | null> {
    const rows = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
    return rows.length ? toMeeting(rows[0]) : null;
  }

  async function list(companyId: string, filters?: { type?: string; status?: string }): Promise<MeetingListItem[]> {
    const conditions = [eq(meetings.companyId, companyId)];
    if (filters?.type) conditions.push(eq(meetings.type, filters.type));
    if (filters?.status) conditions.push(eq(meetings.status, filters.status));

    const rows = await db
      .select()
      .from(meetings)
      .where(and(...conditions))
      .orderBy(desc(meetings.scheduledAt));

    if (!rows.length) return [];

    const meetingIds = rows.map((r) => r.id);

    // Fetch participants with agent info
    const participantRows = await db
      .select({
        p: meetingParticipants,
        agentName: agents.name,
        agentRole: agents.role,
      })
      .from(meetingParticipants)
      .leftJoin(agents, eq(meetingParticipants.agentId, agents.id))
      .where(inArray(meetingParticipants.meetingId, meetingIds));

    // Count decision and learning events per meeting
    const eventCounts = await db
      .select({
        meetingId: meetingEvents.meetingId,
        kind: meetingEvents.kind,
        count: sql<number>`count(*)::int`,
      })
      .from(meetingEvents)
      .where(
        and(
          inArray(meetingEvents.meetingId, meetingIds),
          inArray(meetingEvents.kind, ["decision", "learning"]),
        ),
      )
      .groupBy(meetingEvents.meetingId, meetingEvents.kind);

    const participantsByMeeting = new Map<string, MeetingParticipant[]>();
    for (const row of participantRows) {
      const list = participantsByMeeting.get(row.p.meetingId) ?? [];
      list.push(toParticipant(row.p, { name: row.agentName ?? "", role: row.agentRole }));
      participantsByMeeting.set(row.p.meetingId, list);
    }

    const countsByMeeting = new Map<string, { decision: number; learning: number }>();
    for (const row of eventCounts) {
      const entry = countsByMeeting.get(row.meetingId) ?? { decision: 0, learning: 0 };
      if (row.kind === "decision") entry.decision = row.count;
      if (row.kind === "learning") entry.learning = row.count;
      countsByMeeting.set(row.meetingId, entry);
    }

    return rows.map((r) => {
      const counts = countsByMeeting.get(r.id) ?? { decision: 0, learning: 0 };
      return {
        ...toMeeting(r),
        participants: participantsByMeeting.get(r.id) ?? [],
        decisionCount: counts.decision,
        learningCount: counts.learning,
      };
    });
  }

  async function getDetail(meetingId: string): Promise<MeetingDetail | null> {
    const meeting = await get(meetingId);
    if (!meeting) return null;

    const [participantRows, eventRows] = await Promise.all([
      db
        .select({
          p: meetingParticipants,
          agentName: agents.name,
          agentRole: agents.role,
        })
        .from(meetingParticipants)
        .leftJoin(agents, eq(meetingParticipants.agentId, agents.id))
        .where(eq(meetingParticipants.meetingId, meetingId)),
      db
        .select({
          e: meetingEvents,
          agentName: agents.name,
          agentRole: agents.role,
        })
        .from(meetingEvents)
        .leftJoin(agents, eq(meetingEvents.agentId, agents.id))
        .where(eq(meetingEvents.meetingId, meetingId))
        .orderBy(asc(meetingEvents.seq)),
    ]);

    return {
      ...meeting,
      participants: participantRows.map((r) =>
        toParticipant(r.p, { name: r.agentName ?? "", role: r.agentRole }),
      ),
      events: eventRows.map((r) =>
        toEvent(r.e, { name: r.agentName ?? "", role: r.agentRole }),
      ),
    };
  }

  // ------- Write -------

  async function create(companyId: string, input: CreateMeeting, actor: Actor): Promise<Meeting> {
    // Validate all participant agents belong to company
    if (input.participantAgentIds.length) {
      const agentRows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            inArray(agents.id, input.participantAgentIds),
            eq(agents.companyId, companyId),
          ),
        );
      const foundIds = new Set(agentRows.map((a) => a.id));
      const missing = input.participantAgentIds.filter((id) => !foundIds.has(id));
      if (missing.length) {
        throw unprocessable(`Agents not found in company: ${missing.join(", ")}`);
      }
    }

    const [created] = await db
      .insert(meetings)
      .values({
        companyId,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        agenda: input.agenda ?? null,
        scheduledAt: input.scheduledAt,
        linkedIssueId: input.linkedIssueId ?? null,
        linkedRoutineId: input.linkedRoutineId ?? null,
        initiatedByAgentId: actor.agentId ?? null,
        initiatedByUserId: actor.userId ?? null,
      })
      .returning();

    // Insert participants — first participantAgentId becomes facilitator if none is initiating agent
    if (input.participantAgentIds.length) {
      const facilitatorId = actor.agentId && input.participantAgentIds.includes(actor.agentId)
        ? actor.agentId
        : input.participantAgentIds[0];

      await db.insert(meetingParticipants).values(
        input.participantAgentIds.map((agentId) => ({
          companyId,
          meetingId: created.id,
          agentId,
          role: agentId === facilitatorId ? "facilitator" : "attendee",
        })),
      );
    }

    publishLiveEvent({
      companyId,
      type: "meeting.created",
      payload: { meetingId: created.id, meetingType: input.type, title: input.title },
    });

    return toMeeting(created);
  }

  async function update(meetingId: string, input: UpdateMeeting, actor: Actor): Promise<Meeting | null> {
    const existing = await get(meetingId);
    if (!existing) return null;
    if (existing.status === "completed" || existing.status === "cancelled") {
      throw conflict("Cannot update a completed or cancelled meeting");
    }

    const [updated] = await db
      .update(meetings)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.agenda !== undefined ? { agenda: input.agenda } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(meetings.id, meetingId))
      .returning();

    return updated ? toMeeting(updated) : null;
  }

  async function cancel(meetingId: string, actor: Actor): Promise<Meeting | null> {
    const existing = await get(meetingId);
    if (!existing) return null;
    if (existing.status === "completed") {
      throw conflict("Cannot cancel a completed meeting");
    }

    const [updated] = await db
      .update(meetings)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(meetings.id, meetingId))
      .returning();

    return updated ? toMeeting(updated) : null;
  }

  // ------- Lifecycle -------

  async function start(meetingId: string, actor: Actor): Promise<Meeting> {
    const existing = await get(meetingId);
    if (!existing) throw notFound("Meeting not found");
    if (existing.status !== "scheduled") {
      throw conflict(`Cannot start a meeting with status '${existing.status}'`);
    }

    const [updated] = await db
      .update(meetings)
      .set({
        status: "in_progress",
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(meetings.id, meetingId))
      .returning();

    publishLiveEvent({
      companyId: existing.companyId,
      type: "meeting.started",
      payload: { meetingId, meetingType: existing.type, title: existing.title },
    });

    return toMeeting(updated);
  }

  async function complete(meetingId: string, notes: string | null, actor: Actor): Promise<Meeting> {
    const existing = await get(meetingId);
    if (!existing) throw notFound("Meeting not found");
    if (existing.status !== "in_progress") {
      throw conflict(`Cannot complete a meeting with status '${existing.status}'`);
    }

    const [updated] = await db
      .update(meetings)
      .set({
        status: "completed",
        completedAt: new Date(),
        meetingNotes: notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(meetings.id, meetingId))
      .returning();

    publishLiveEvent({
      companyId: existing.companyId,
      type: "meeting.completed",
      payload: { meetingId, meetingType: existing.type, title: existing.title },
    });

    // Memory transfer happens here; integrate with hippocampus-bridge in Phase 5
    return toMeeting(updated);
  }

  // ------- Participants -------

  async function addParticipant(
    meetingId: string,
    agentId: string,
    role: string = "attendee",
  ): Promise<MeetingParticipant> {
    const meeting = await get(meetingId);
    if (!meeting) throw notFound("Meeting not found");

    // Verify agent belongs to meeting's company
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, meeting.companyId)))
      .limit(1);
    if (!agentRows.length) throw unprocessable("Agent not found in meeting's company");

    const [created] = await db
      .insert(meetingParticipants)
      .values({
        companyId: meeting.companyId,
        meetingId,
        agentId,
        role,
      })
      .onConflictDoNothing()
      .returning();

    if (!created) {
      // Already exists — return existing
      const existing = await db
        .select()
        .from(meetingParticipants)
        .where(
          and(
            eq(meetingParticipants.meetingId, meetingId),
            eq(meetingParticipants.agentId, agentId),
          ),
        )
        .limit(1);
      return toParticipant(existing[0], agentRows[0]);
    }

    return toParticipant(created, agentRows[0]);
  }

  async function removeParticipant(meetingId: string, agentId: string): Promise<boolean> {
    const result = await db
      .delete(meetingParticipants)
      .where(
        and(
          eq(meetingParticipants.meetingId, meetingId),
          eq(meetingParticipants.agentId, agentId),
        ),
      )
      .returning();
    return result.length > 0;
  }

  async function submitContribution(
    meetingId: string,
    agentId: string,
    contribution: MeetingParticipantContribution,
  ): Promise<MeetingParticipant | null> {
    const meeting = await get(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    if (meeting.status !== "in_progress") {
      throw conflict("Contributions can only be submitted to in-progress meetings");
    }

    const [updated] = await db
      .update(meetingParticipants)
      .set({
        contribution: contribution as unknown as typeof meetingParticipants.$inferInsert["contribution"],
        joinedAt: sql`coalesce(${meetingParticipants.joinedAt}, now())`,
      })
      .where(
        and(
          eq(meetingParticipants.meetingId, meetingId),
          eq(meetingParticipants.agentId, agentId),
        ),
      )
      .returning();

    if (!updated) return null;

    const agentRow = await db
      .select({ name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    return toParticipant(updated, agentRow[0] ?? null);
  }

  // ------- Events -------

  async function addEvent(
    meetingId: string,
    input: AddMeetingEvent,
  ): Promise<MeetingEvent> {
    const meeting = await get(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    if (meeting.status !== "in_progress") {
      throw conflict("Events can only be added to in-progress meetings");
    }

    // Auto-increment seq
    const [maxRow] = await db
      .select({ maxSeq: sql<number>`coalesce(max(${meetingEvents.seq}), 0)` })
      .from(meetingEvents)
      .where(eq(meetingEvents.meetingId, meetingId));

    const nextSeq = (maxRow?.maxSeq ?? 0) + 1;

    const [created] = await db
      .insert(meetingEvents)
      .values({
        companyId: meeting.companyId,
        meetingId,
        seq: nextSeq,
        kind: input.kind,
        agentId: input.agentId ?? null,
        content: input.content,
        payload: input.payload ?? null,
      })
      .returning();

    let agent: { name: string; role: string | null } | null = null;
    if (created.agentId) {
      const agentRow = await db
        .select({ name: agents.name, role: agents.role })
        .from(agents)
        .where(eq(agents.id, created.agentId))
        .limit(1);
      agent = agentRow[0] ?? null;
    }

    publishLiveEvent({
      companyId: meeting.companyId,
      type: "meeting.event",
      payload: {
        meetingId,
        eventId: created.id,
        kind: input.kind,
        agentId: input.agentId,
        seq: nextSeq,
      },
    });

    return toEvent(created, agent);
  }

  async function listEvents(meetingId: string): Promise<MeetingEvent[]> {
    const rows = await db
      .select({
        e: meetingEvents,
        agentName: agents.name,
        agentRole: agents.role,
      })
      .from(meetingEvents)
      .leftJoin(agents, eq(meetingEvents.agentId, agents.id))
      .where(eq(meetingEvents.meetingId, meetingId))
      .orderBy(asc(meetingEvents.seq));

    return rows.map((r) =>
      toEvent(r.e, { name: r.agentName ?? "", role: r.agentRole }),
    );
  }

  // ------- Escalation -------

  async function createEscalation(
    companyId: string,
    input: CreateEscalationMeeting,
    actor: Actor,
  ): Promise<Meeting> {
    // Fetch the blocker agent and their manager
    const blockerRows = await db
      .select({
        id: agents.id,
        name: agents.name,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(and(eq(agents.id, input.blockerAgentId), eq(agents.companyId, companyId)))
      .limit(1);

    if (!blockerRows.length) throw notFound("Blocker agent not found in company");
    const blocker = blockerRows[0];

    if (!blocker.reportsTo) {
      throw unprocessable(`Agent '${blocker.name}' has no manager set (reportsTo is null). Cannot escalate.`);
    }

    const participantIds = [input.blockerAgentId, blocker.reportsTo];

    const meeting = await create(
      companyId,
      {
        type: "escalation",
        title: `Escalation: ${input.description.slice(0, 100)}`,
        description: input.description,
        scheduledAt: new Date(),
        participantAgentIds: participantIds,
        linkedIssueId: input.linkedIssueId ?? null,
      },
      actor,
    );

    // Auto-start escalation meetings
    const started = await start(meeting.id, actor);

    publishLiveEvent({
      companyId,
      type: "meeting.escalation",
      payload: {
        meetingId: started.id,
        blockerAgentId: input.blockerAgentId,
        managerId: blocker.reportsTo,
      },
    });

    return started;
  }

  // ------- Public API -------

  return {
    get,
    list,
    getDetail,
    create,
    update,
    cancel,
    start,
    complete,
    addParticipant,
    removeParticipant,
    submitContribution,
    addEvent,
    listEvents,
    createEscalation,
  };
}
