import type { AgentIdentity, Meeting, Task } from "@arceus/contracts";
import type { CeoCard } from "../agents/ceo.js";
import { getAgentByRole, uniqueStrings, createWorkflowTask } from "@arceus/task-engine";
import { getSnapshot, upsertMeeting, upsertTask } from "../persistence/store.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphMeeting, resolveActiveSprintId } from "../observability/graph-emitter.js";
import { emitReactive } from "../orchestration/reactive.js";
import type { MeetingAgendaInput, MeetingDecisionInput, MeetingLearningInput, TaskModificationInput, MemoryModificationInput } from "../orchestration/state.js";
import { deriveMeetingMemoryModifications, applyMeetingEffects } from "./effects.js";

export function recordMeeting(params: {
  type: Meeting["type"];
  facilitatorRole: AgentIdentity["role"];
  participantRoles: AgentIdentity["role"][];
  summary: string;
  agenda: MeetingAgendaInput[];
  decisions?: MeetingDecisionInput[];
  learnings?: MeetingLearningInput[];
  taskModifications?: TaskModificationInput[];
  memoryModifications?: MemoryModificationInput[];
}) {
  const snapshot = getSnapshot();
  const facilitatorAgent = getAgentByRole(snapshot, params.facilitatorRole);
  const participantAgentIds = uniqueStrings(
    params.participantRoles
      .map((role) => getAgentByRole(snapshot, role)?.id)
      .filter(Boolean),
    12,
  );
  const now = new Date().toISOString();
  const meetingMemoryModifications = deriveMeetingMemoryModifications(params);

  const facilitatorContribution: Meeting["contributions"][number] = {
    agentId: facilitatorAgent?.id ?? "unknown_agent",
    agentName: facilitatorAgent?.name ?? params.facilitatorRole,
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
            action: (tm.modificationType === "cancel" ? "modify_task"
                   : tm.modificationType === "assign" ? "create_task"
                   : "modify_task") as "create_task" | "modify_task",
            taskAction: {
              type: (tm.modificationType === "assign" ? "create" : "update") as "create" | "update",
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
    companyId: snapshot.company.id,
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

  upsertMeeting(meeting);
  applyMeetingEffects(params.taskModifications ?? [], meetingMemoryModifications);

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

function createTaskFromCeoDelta(delta: CeoCard["meeting"]["task_deltas"][number]) {
  const snapshot = getSnapshot();
  const agent = getAgentByRole(snapshot, delta.assigned_role);
  if (!agent) return null;
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
  upsertTask(task);
  return task;
}

function resolveTaskFromHint(targetTaskHint: string | null | undefined) {
  if (!targetTaskHint) return null;
  const hint = targetTaskHint.trim().toLowerCase();
  if (!hint) return null;
  return (
    getSnapshot().tasks.find((task) => {
      const haystack = [task.id, task.title, task.kind, task.description, task.problemStatement].join(" ").toLowerCase();
      return haystack.includes(hint);
    }) ?? null
  );
}

export function recordCeoCardMeeting(card: CeoCard, boardMessage: string, ceoText: string) {
  if (!card.meeting.create) return null;
  const snapshot = getSnapshot();
  if (snapshot.company.status !== "active" || snapshot.agents.length === 0) return null;

  const taskModifications: TaskModificationInput[] = [];
  const participantRoles = new Set<AgentIdentity["role"]>(["ceo"]);

  for (const delta of card.meeting.task_deltas) {
    participantRoles.add(delta.assigned_role);

    if (delta.action === "create") {
      const task = createTaskFromCeoDelta(delta);
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

    const targetTask = resolveTaskFromHint(delta.target_task_hint);
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

  const meeting = recordMeeting({
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
