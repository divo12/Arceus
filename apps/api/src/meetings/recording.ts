import type { AgentIdentity, Meeting, Task } from "@arceus/contracts";
import type { CeoCard } from "../agents/ceo.js";
import { getAgentByRole, uniqueStrings, createWorkflowTask } from "@arceus/task-engine";
import { upsertMeeting, upsertTask } from "../persistence/mutations/index.js";
import { requireActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphMeeting, resolveActiveSprintId } from "../observability/graph-emitter/index.js";
import { emitReactive } from "../orchestration/reactive.js";
import type { MeetingAgendaInput, MeetingDecisionInput, MeetingLearningInput, TaskModificationInput, MemoryModificationInput } from "../orchestration/state.js";
import { deriveMeetingMemoryModifications, applyMeetingEffects } from "./effects.js";

/**
 * Record a completed meeting: persist it, apply task/memory effects,
 * emit activity + graph events, and trigger reactive wakes. Spec 31
 * Phase 7.B.2 / 7.C.c — async; agent lookups + memory-mod task lookups
 * go through canonical repos. CompanyId resolves via the seam helper.
 */
export async function recordMeeting(params: {
  type: Meeting["type"];
  facilitatorRole: AgentIdentity["role"];
  participantRoles: AgentIdentity["role"][];
  summary: string;
  agenda: MeetingAgendaInput[];
  decisions?: MeetingDecisionInput[];
  learnings?: MeetingLearningInput[];
  taskModifications?: TaskModificationInput[];
  memoryModifications?: MemoryModificationInput[];
}): Promise<Meeting> {
  const companyId = requireActiveCompanyId();
  const db = getDb();

  const distinctRoles = Array.from(new Set([params.facilitatorRole, ...params.participantRoles]));
  const agentByRole = new Map<AgentIdentity["role"], { id: string; displayName: string }>();
  for (const role of distinctRoles) {
    const agent = await agentsRepo.findAgentByRole(db, companyId, role);
    if (agent) agentByRole.set(role, { id: agent.id, displayName: agent.displayName });
  }
  const facilitatorAgent = agentByRole.get(params.facilitatorRole) ?? null;
  const participantAgentIds = uniqueStrings(
    params.participantRoles.map((role) => agentByRole.get(role)?.id).filter((id): id is string => Boolean(id)),
    12,
  );
  const now = new Date().toISOString();
  const meetingMemoryModifications = await deriveMeetingMemoryModifications(params);

  const facilitatorContribution: Meeting["contributions"][number] = {
    agentId: facilitatorAgent?.id ?? "unknown_agent",
    agentName: facilitatorAgent?.displayName ?? params.facilitatorRole,
    agentRole: params.facilitatorRole,
    contribution: {
      whatIDid: params.agenda.filter(a => a.type === "update").map(a => a.content).join("; ") || params.summary,
      whatImDoing: "",
      blockers: params.agenda.filter(a => a.type === "blocker").map(a => a.content).join("; "),
      learnings: (params.learnings ?? []).map(l => l.content).join("; "),
      questionsForTeam: params.agenda.filter(a => a.type === "question").map(a => a.content).join("; "),
    },
    submittedAt: now,
  };

  const resolutions: Meeting["resolutions"] = (params.decisions ?? []).length > 0 || (params.taskModifications ?? []).length > 0
    ? {
        decisions: [
          ...(params.decisions ?? []).map(d => ({
            conflictId: null,
            blockerId: null,
            decision: d.description,
            action: "note" as const,
          })),
          ...(params.taskModifications ?? []).map(tm => ({
            conflictId: null,
            blockerId: null,
            decision: tm.details,
            action: (tm.modificationType === "cancel" ? "modify_task" as const
                   : tm.modificationType === "assign" ? "create_task" as const
                   : "modify_task" as const),
            taskAction: {
              type: (tm.modificationType === "assign" ? "create" as const : "update" as const),
              issueId: tm.taskId,
              assigneeRole: tm.assignedRole ?? undefined,
              newStatus: tm.resultingStatus ?? undefined,
              newPriority: tm.priority ?? undefined,
            },
          })),
        ],
      }
    : null;

  const meeting: Meeting = {
    id: `meeting_${crypto.randomUUID()}`,
    companyId,
    scheduleId: null,
    type: params.type,
    title: params.summary,
    status: "completed",
    facilitatorAgentId: facilitatorAgent?.id ?? "unknown_agent",
    participantAgentIds,
    contributions: [facilitatorContribution],
    synthesis: null,
    resolutions,
    brief: null,
    healthSnapshot: null,
    createdAt: now,
    completedAt: now,
  };

  await upsertMeeting(meeting);
  await applyMeetingEffects(companyId, params.taskModifications ?? [], meetingMemoryModifications);

  if (params.type === "escalation") {
    for (const role of params.participantRoles) {
      if (role !== params.facilitatorRole) {
        emitReactive(role, "escalation_received");
      }
    }
  }

  emitEmployeeActivity(
    params.facilitatorRole,
    "info",
    `${params.type.replace(/_/g, " ")} meeting complete: ${params.summary}`,
    { meetingId: meeting.id },
  );

  const activeSprintId = resolveActiveSprintId();
  if (activeSprintId) {
    const meetingNodeId = (params as { _graphNodeId?: string })._graphNodeId ?? null;
    const triggerItems = params.agenda
      .filter(a => a.type === "blocker" || a.type === "update")
      .map(a => a.content.slice(0, 100));
    const trigger = triggerItems.length > 0
      ? triggerItems.join("; ")
      : `${params.type.replace(/_/g, " ")} by ${params.facilitatorRole}`;

    emitGraphMeeting(
      activeSprintId,
      meetingNodeId,
      meeting.id,
      params.type,
      params.facilitatorRole,
      params.participantRoles,
      params.summary,
      trigger,
      (params.decisions ?? []).map(d => d.description),
      (meetingMemoryModifications ?? []).map(m => `${m.role}: ${m.content.slice(0, 80)}`),
      false,
    );
  }

  return meeting;
}

/**
 * Build a follow-up task from a CEO-card delta. Still reads the
 * snapshot because `createWorkflowTask` (in `@arceus/task-engine`)
 * requires it; that's a B.3 concern. Agent lookup can flip to
 * canonical here without changing the rest.
 */
async function createTaskFromCeoDelta(
  companyId: string,
  delta: CeoCard["meeting"]["task_deltas"][number],
): Promise<Task | null> {
  const agent = await agentsRepo.findAgentByRole(getDb(), companyId, delta.assigned_role);
  if (!agent) return null;
  // Spec 31 Phase 7.C.c — canonical-backed view for createWorkflowTask.
  const snapshot = await buildSnapshotView(companyId);
  const task = createWorkflowTask(
    snapshot,
    "follow_up",
    delta.assigned_role,
    delta.title,
    delta.details,
    delta.details,
    delta.title,
    ["Captured from a CEO meeting.", "Ready for manager review or execution."],
    delta.priority,
    "created",
  );
  await upsertTask(task);
  return task;
}

/**
 * Fuzzy task search by id/title/kind/description/problemStatement
 * fragments. Spec 31 Phase 7.B.2 — list resolves through
 * `tasksRepo.listByCompanyHydrated`; the substring scan stays in TS
 * since the haystack is small (one company's worth of tasks).
 */
async function resolveTaskFromHint(companyId: string, targetTaskHint: string | null | undefined): Promise<Task | null> {
  if (!targetTaskHint) return null;
  const hint = targetTaskHint.trim().toLowerCase();
  if (!hint) return null;
  const tasks = await tasksRepo.listByCompanyHydrated(getDb(), companyId);
  return (
    tasks.find((task) => {
      const haystack = [task.id, task.title, task.kind, task.description, task.problemStatement].join(" ").toLowerCase();
      return haystack.includes(hint);
    }) ?? null
  );
}

/** Record a meeting derived from a CEO card, creating tasks and routing board directives. */
export async function recordCeoCardMeeting(card: CeoCard, boardMessage: string, ceoText: string): Promise<Meeting | null> {
  if (!card.meeting.create) return null;
  // Spec 31 Phase 7.C.c — read from canonical via the seam helper.
  const companyId = requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);
  if (snapshot.company.status !== "active" || snapshot.agents.length === 0) return null;

  const taskModifications: TaskModificationInput[] = [];
  const participantRoles = new Set<AgentIdentity["role"]>(["ceo"]);

  for (const delta of card.meeting.task_deltas) {
    participantRoles.add(delta.assigned_role);

    if (delta.action === "create") {
      const task = await createTaskFromCeoDelta(companyId, delta);
      if (!task) continue;
      taskModifications.push({
        taskId: task.id,
        modificationType: "assign",
        details: delta.details,
        assignedRole: delta.assigned_role,
        priority: delta.priority,
        resultingStatus: "planned",
      });
      continue;
    }

    const targetTask = await resolveTaskFromHint(companyId, delta.target_task_hint);
    if (!targetTask) continue;

    if (delta.action === "reprioritize") {
      taskModifications.push({
        taskId: targetTask.id,
        modificationType: "reprioritize",
        details: delta.details,
        priority: delta.priority,
      });
      continue;
    }

    if (delta.action === "reassign") {
      taskModifications.push({
        taskId: targetTask.id,
        modificationType: "reassign",
        details: delta.details,
        assignedRole: delta.assigned_role,
      });
      continue;
    }

    if (delta.action === "cancel") {
      taskModifications.push({
        taskId: targetTask.id,
        modificationType: "cancel",
        details: delta.details,
        resultingStatus: "cancelled",
      });
    }
  }

  const ceoMeetingType = card.meeting.type ?? (card.card_type === "status_update" ? "escalation" : "ad_hoc");
  const meetingType: Meeting["type"] = ceoMeetingType === "escalation" ? "escalation" : "eval_triggered";
  const agendaType = meetingType === "escalation" ? "blocker" : card.card_type === "clarifying_question" ? "question" : "proposal";

  const meeting = await recordMeeting({
    type: meetingType,
    facilitatorRole: "ceo",
    participantRoles: Array.from(participantRoles),
    summary: card.meeting.summary || card.summary,
    agenda: [
      {
        topic: "Board message",
        type: "update",
        content: boardMessage,
        raisedByRole: "ceo",
      },
      {
        topic: card.title,
        type: agendaType,
        content: ceoText || card.summary,
        raisedByRole: "ceo",
      },
    ],
    decisions: [
      {
        description: card.meeting.rationale,
        decidedByRoles: ["ceo"],
        impactIds: taskModifications.map((item) => item.taskId),
      },
    ],
    taskModifications,
    memoryModifications: [
      {
        role: "ceo",
        modificationType: "current_focus",
        content: `Board directive: ${boardMessage}`,
      },
      ...card.meeting.task_deltas.map((delta) => ({
        role: delta.assigned_role,
        modificationType: "current_focus" as const,
        content: delta.title,
      })),
    ],
  });

  // Reactive: wake each participant agent (board directive)
  for (const role of participantRoles) {
    if (role !== "ceo") emitReactive(role, "board_message");
  }

  return meeting;
}
