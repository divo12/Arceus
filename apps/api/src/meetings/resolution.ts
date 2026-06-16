/**
 * Meeting Resolution — Spec 18 Phase 5
 *
 * Two surviving primitives after the Facilitator Agent (Spec 24 Phase 4b)
 * superseded the standalone resolveMeeting + buildDailySyncBrief LLM calls:
 *  - executeMeetingDecisions() — applies resolution decisions to the store
 *    (create tasks, modify tasks, create escalation approvals)
 *  - postDailySyncSummary() — posts a daily_sync_summary card to CEO chat
 */

import type {
  Meeting,
  CompanySnapshot,
  Task,
  ChatMessage,
  Approval,
  DailySyncBrief,
} from "@arceus/contracts";
import { defaultHeartbeat } from "@arceus/contracts";

// ── Execute Decisions ──────────────────────────────────────

interface ExecutionResult {
  tasksCreated: number;
  tasksModified: number;
  escalationsCreated: number;
}

interface ExecutionDeps {
  /** Spec 31 Phase 7.C.d — async to write to canonical. */
  upsertTask: (task: Task) => Promise<Task>;
  updateTask: (taskId: string, updater: (t: Task) => Task) => Promise<Task | null>;
  upsertApproval: (approval: Approval) => Promise<Approval>;
  appendChatMessage: (msg: ChatMessage) => Promise<ChatMessage>;
  flush: () => Promise<void>;
}

/**
 * Apply resolution decisions to the store: create tasks, modify tasks,
 * create escalation approvals + CEO chat cards.
 */
export async function executeMeetingDecisions(
  meeting: Meeting,
  snap: CompanySnapshot,
  deps: ExecutionDeps,
): Promise<ExecutionResult> {
  const resolutions = meeting.resolutions;
  if (!resolutions) return { tasksCreated: 0, tasksModified: 0, escalationsCreated: 0 };

  let tasksCreated = 0;
  let tasksModified = 0;
  let escalationsCreated = 0;

  for (const decision of resolutions.decisions) {
    switch (decision.action) {
      case "create_task": {
        if (decision.taskAction?.type !== "create") break;
        const ta = decision.taskAction;
        const task: Task = {
          id: `task_${crypto.randomUUID()}`,
          companyId: snap.company.id,
          sprintId: snap.company.currentSprintId ?? null,
          kind: "follow_up",
          title: ta.title ?? decision.decision,
          description: ta.description ?? decision.decision,
          problemStatement: decision.decision,
          deliverable: ta.title ?? decision.decision,
          definitionOfDone: ["Resolve the identified issue"],
          status: "planned",
          priority: ta.newPriority ?? "medium",
          sequence: null,
          assignedRole: ta.assigneeRole ?? "developer",
          assignedAgentId: null,
          parentTaskId: null,
          dependsOnTaskIds: [],
          childTaskIds: [],
          artifactIds: [],
          localPreviewUrl: null,
          plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
          heartbeat: defaultHeartbeat(),
          executorState: { currentCommand: null, commandsExecuted: [], results: [] },
          verifierState: { isVerified: false, feedback: null, verifiedByAgentId: null },
          costCents: 0,
          iterationCount: 0,
          maxIterations: 3,
          incomingArtifactIds: [],
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        };
        await deps.upsertTask(task);
        tasksCreated++;
        break;
      }
      case "modify_task": {
        if (!decision.taskAction) break;
        const ta = decision.taskAction;
        const targetId = ta.issueId;
        if (!targetId) break;
        await deps.updateTask(targetId, (t) => ({
          ...t,
          ...(ta.title ? { title: ta.title } : {}),
          ...(ta.description ? { description: ta.description } : {}),
          ...(ta.newStatus ? { status: ta.newStatus } : {}),
          ...(ta.newPriority ? { priority: ta.newPriority } : {}),
          ...(ta.assigneeRole ? { assignedRole: ta.assigneeRole } : {}),
        }));
        tasksModified++;
        break;
      }
      case "escalate_to_board": {
        if (!decision.escalation) break;
        const esc = decision.escalation;

        // Create approval record
        const approval: Approval = {
          id: `approval_${crypto.randomUUID()}`,
          companyId: snap.company.id,
          type: "meeting_blocker",
          status: "pending",
          title: esc.question,
          description: esc.context,
          requestedByAgentId: meeting.facilitatorAgentId,
          meetingId: meeting.id,
          agendaItemId: decision.conflictId ?? decision.blockerId ?? null,
          resolutionSummary: null,
        };
        await deps.upsertApproval(approval);

        // Post CEO chat card for board visibility
        await deps.appendChatMessage({
          id: `msg_${crypto.randomUUID()}`,
          companyId: snap.company.id,
          sprintId: snap.company.currentSprintId ?? null,
          agentId: meeting.facilitatorAgentId,
          role: "ceo",
          content: `**Escalation from meeting "${meeting.title}"**\n\n${esc.question}\n\n_Context:_ ${esc.context}\n\n_Severity:_ ${esc.severity}`,
          cardType: "approval_request",
          cardData: { approvalId: approval.id, meetingId: meeting.id, severity: esc.severity },
          createdAt: new Date().toISOString(),
        });

        escalationsCreated++;
        break;
      }
      // "note" and "no_action" require no store changes
    }
  }

  return { tasksCreated, tasksModified, escalationsCreated };
}

// ── Daily Sync Brief ───────────────────────────────────────

/**
 * Post a daily_sync_summary card to CEO chat with the brief content.
 */
export async function postDailySyncSummary(
  meeting: Meeting,
  brief: DailySyncBrief,
  snap: CompanySnapshot,
  appendChatMessage: (msg: ChatMessage) => Promise<ChatMessage>,
): Promise<void> {
  const blockerLine = brief.activeBlockers.length > 0
    ? `\n**Blockers:** ${brief.activeBlockers.join("; ")}`
    : "";

  const decisionLine = brief.decisionsFromMeeting.length > 0
    ? `\n**Decisions:** ${brief.decisionsFromMeeting.join("; ")}`
    : "";

  const content = [
    `**Daily Sync Brief** — ${brief.date}`,
    "",
    brief.companyStatus,
    "",
    brief.teamUpdates.map((u) => `• **${u.agentRole}**: ${u.summary}`).join("\n"),
    blockerLine,
    decisionLine,
  ].filter(Boolean).join("\n");

  await appendChatMessage({
    id: `msg_${crypto.randomUUID()}`,
    companyId: snap.company.id,
    sprintId: snap.company.currentSprintId ?? null,
    agentId: meeting.facilitatorAgentId,
    role: "ceo",
    content,
    cardType: "daily_sync_summary",
    cardData: { meetingId: meeting.id, date: brief.date },
    createdAt: new Date().toISOString(),
  });
}
