/**
 * Meeting Resolution — Spec 18 Phase 5
 *
 * Two core functions:
 *  1. resolveMeeting() — CEO/facilitator LLM call (gpt-4o) that reads
 *     synthesis output and decides how to handle conflicts/blockers
 *  2. executeMeetingDecisions() — applies resolution decisions to the store
 *     (create tasks, modify tasks, create escalation approvals)
 *
 * Also:
 *  - buildDailySyncBrief() — produces a DailySyncBrief from a completed meeting
 *  - postDailySyncSummary() — posts a daily_sync_summary card to CEO chat
 */

import { z } from "zod";
import { resolutionOutputSchema, dailySyncBriefSchema } from "@arceus/contracts";
import type {
  Meeting,
  CompanySnapshot,
  Task,
  ChatMessage,
  Approval,
  ResolutionOutput,
  DailySyncBrief,
} from "@arceus/contracts";
import { structuredCompletion } from "../infra/azure-openai.js";

// ── Resolution (CEO LLM call) ──────────────────────────────

/**
 * CEO/facilitator resolves conflicts and blockers from the synthesis.
 * Uses gpt-4o for higher reasoning quality on conflict decisions.
 */
export async function resolveMeeting(
  meeting: Meeting,
  snap: CompanySnapshot,
): Promise<ResolutionOutput> {
  const synthesis = meeting.synthesis;
  if (!synthesis) return { decisions: [] };

  const issueCount = synthesis.conflicts.length + synthesis.blockers.length;
  if (issueCount === 0) return { decisions: [] };

  const conflictText = synthesis.conflicts
    .map((c) => `- [${c.id}] (${c.severity}) ${c.description}\n  Agents: ${c.involvedAgentIds.join(", ")}\n  Suggested: ${c.suggestedResolution}`)
    .join("\n");

  const blockerText = synthesis.blockers
    .map((b) => `- [${b.id}] ${b.description}\n  Reported by: ${b.reportedByAgentId}\n  Suggested: ${b.suggestedAction}`)
    .join("\n");

  const alignmentText = synthesis.alignmentIssues.length > 0
    ? synthesis.alignmentIssues.map((a) => `- [${a.id}] ${a.description}`).join("\n")
    : "None.";

  const currentTasks = snap.tasks
    .filter((t) => t.status !== "completed" && t.status !== "cancelled")
    .slice(0, 20)
    .map((t) => `- [${t.id}] [${t.status}] ${t.title} (${t.assignedRole})`)
    .join("\n");

  const system = [
    "You are the CEO facilitating a team meeting. You must resolve conflicts and blockers.",
    "For each issue, decide on an action:",
    '- "create_task": Create a new task to address the issue',
    '- "modify_task": Update an existing task (provide issueId = existing task ID)',
    '- "escalate_to_board": Escalate to the board for human decision (use sparingly, only for critical/external decisions)',
    '- "note": Acknowledge the issue, no action needed now',
    '- "no_action": Dismiss as not requiring action',
    "",
    "When creating/modifying tasks, provide concrete actionable details.",
    "Only escalate truly critical items that need human board input.",
    "For each decision, set conflictId or blockerId to link back to the synthesis issue.",
  ].join("\n");

  const user = [
    `Meeting: "${meeting.title}" (${meeting.type.replace(/_/g, " ")})`,
    `Company: ${snap.company.name}`,
    "",
    "## Conflicts",
    conflictText || "None.",
    "",
    "## Blockers",
    blockerText || "None.",
    "",
    "## Alignment Issues",
    alignmentText,
    "",
    "## Current Tasks (for reference when modifying)",
    currentTasks || "No active tasks.",
    "",
    "Produce resolution decisions for each conflict and blocker.",
  ].join("\n");

  return structuredCompletion(
    "ceoDeployment",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    resolutionOutputSchema,
    "meeting_resolution",
    { temperature: 0.3 },
  );
}

// ── Execute Decisions ──────────────────────────────────────

export interface ExecutionResult {
  tasksCreated: number;
  tasksModified: number;
  escalationsCreated: number;
}

export interface ExecutionDeps {
  upsertTask: (task: Task) => Task;
  updateTask: (taskId: string, updater: (t: Task) => Task) => Task | null;
  upsertApproval: (approval: Approval) => Approval;
  appendChatMessage: (msg: ChatMessage) => ChatMessage;
  flush: () => Promise<void>;
}

/**
 * Apply resolution decisions to the store: create tasks, modify tasks,
 * create escalation approvals + CEO chat cards.
 */
export function executeMeetingDecisions(
  meeting: Meeting,
  snap: CompanySnapshot,
  deps: ExecutionDeps,
): ExecutionResult {
  const resolutions = meeting.resolutions;
  if (!resolutions) return { tasksCreated: 0, tasksModified: 0, escalationsCreated: 0 };

  let tasksCreated = 0;
  let tasksModified = 0;
  let escalationsCreated = 0;

  for (const decision of resolutions.decisions) {
    switch (decision.action) {
      case "create_task": {
        if (!decision.taskAction || decision.taskAction.type !== "create") break;
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
          priority: (ta.newPriority as Task["priority"]) ?? "medium",
          sequence: null,
          assignedRole: (ta.assigneeRole as Task["assignedRole"]) ?? "developer",
          assignedAgentId: null,
          parentTaskId: null,
          dependsOnTaskIds: [],
          childTaskIds: [],
          artifactIds: [],
          localPreviewUrl: null,
          plannerState: { objective: "", planSteps: [], selectedTools: [], currentStepIndex: 0 },
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
        deps.upsertTask(task);
        tasksCreated++;
        break;
      }
      case "modify_task": {
        if (!decision.taskAction) break;
        const ta = decision.taskAction;
        const targetId = ta.issueId;
        if (!targetId) break;
        deps.updateTask(targetId, (t) => ({
          ...t,
          ...(ta.title ? { title: ta.title } : {}),
          ...(ta.description ? { description: ta.description } : {}),
          ...(ta.newStatus ? { status: ta.newStatus as Task["status"] } : {}),
          ...(ta.newPriority ? { priority: ta.newPriority as Task["priority"] } : {}),
          ...(ta.assigneeRole ? { assignedRole: ta.assigneeRole as Task["assignedRole"] } : {}),
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
        deps.upsertApproval(approval);

        // Post CEO chat card for board visibility
        deps.appendChatMessage({
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
 * Build a DailySyncBrief from a completed daily_sync meeting.
 * Uses gpt-4o-mini for concise summarization.
 */
export async function buildDailySyncBrief(
  meeting: Meeting,
  snap: CompanySnapshot,
): Promise<DailySyncBrief> {
  const contributionSummary = meeting.contributions
    .map((c) => `${c.agentRole}: Did="${c.contribution.whatIDid}", Doing="${c.contribution.whatImDoing}", Blockers="${c.contribution.blockers}"`)
    .join("\n");

  const decisionSummary = meeting.resolutions?.decisions
    .filter((d) => d.action !== "no_action" && d.action !== "note")
    .map((d) => `- [${d.action}] ${d.decision}`)
    .join("\n") ?? "No decisions.";

  const system = [
    "You are a meeting summarizer. Produce a concise daily sync brief.",
    "companyStatus: 1-2 sentence overall status.",
    "teamUpdates: one short summary per agent role.",
    "activeBlockers: list only genuine current blockers (empty array if none).",
    "upcomingDependencies: list upcoming cross-team dependencies (empty array if none).",
    "decisionsFromMeeting: list key decisions made (empty array if none).",
  ].join("\n");

  const user = [
    `Company: ${snap.company.name}`,
    `Sprint: #${snap.company.currentSprintNumber ?? "none"}`,
    "",
    "## Contributions",
    contributionSummary || "No contributions.",
    "",
    "## Decisions",
    decisionSummary,
    "",
    "Produce the daily sync brief.",
  ].join("\n");

  return structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    dailySyncBriefSchema,
    "daily_sync_brief",
    { temperature: 0.3 },
  );
}

/**
 * Post a daily_sync_summary card to CEO chat with the brief content.
 */
export function postDailySyncSummary(
  meeting: Meeting,
  brief: DailySyncBrief,
  snap: CompanySnapshot,
  appendChatMessage: (msg: ChatMessage) => ChatMessage,
): void {
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

  appendChatMessage({
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
