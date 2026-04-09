import { z } from "zod";
import type { ChatMessage, CompanySnapshot } from "@arceus/contracts";
import { getRoleSoul } from "@arceus/company-runtime";
import { structuredCompletion } from "./azure-openai";

const strategyRoleSchema = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
const coreStrategyRoles = ["ceo", "cto", "pm", "developer"] as const;
const ceoMeetingTypeSchema = z.enum(["ad_hoc", "sync", "escalation"]);
export const ceoStageSchema = z.enum(["welcome", "idea_refinement", "team_design", "kickoff", "execution", "between_sprints"]);

const ceoTaskDeltaSchema = z.object({
  action: z.enum(["create", "reprioritize", "reassign", "cancel"]),
  title: z.string(),
  details: z.string(),
  assigned_role: strategyRoleSchema,
  priority: z.enum(["critical", "high", "medium", "low"]),
  target_task_hint: z.string().nullable(),
});

const ceoMeetingIntentSchema = z.object({
  create: z.boolean(),
  type: ceoMeetingTypeSchema.nullable(),
  summary: z.string(),
  rationale: z.string(),
  task_deltas: z.array(ceoTaskDeltaSchema).max(4),
}).superRefine((value, ctx) => {
  if (value.create && value.type === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Meeting type is required when create is true.",
    });
  }

  if (!value.create && value.task_deltas.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_deltas"],
      message: "Task deltas must be empty when create is false.",
    });
  }
});

function validateStrategyRoles(
  roles: Array<{ role: string; parent_role: string | null }>,
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();

  roles.forEach((entry, index) => {
    if (seen.has(entry.role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "role"],
        message: `Duplicate role is not allowed: ${entry.role}`,
      });
      return;
    }

    seen.add(entry.role);

    if (entry.role === "ceo" && entry.parent_role !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "parent_role"],
        message: "CEO must have a null parent_role.",
      });
    }

    if (entry.role !== "ceo" && entry.parent_role === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "parent_role"],
        message: `${entry.role} must report to a manager.`,
      });
    }
  });

  coreStrategyRoles.forEach((role) => {
    if (!seen.has(role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Strategy output must include the core role: ${role}`,
      });
    }
  });
}

export const strategyOutputSchema = z.object({
  strategy_title: z.string(),
  summary: z.string(),
  first_release: z.string(),
  scope_boundary: z.array(z.string()),
  role_rationale: z.array(z.string()),
  roles: z.array(
    z.object({
      role: strategyRoleSchema,
      title: z.string(),
      parent_role: strategyRoleSchema.nullable(),
      capabilities: z.array(z.string()),
    }),
  ).min(4).max(8).superRefine(validateStrategyRoles),
});

export type StrategyOutput = z.infer<typeof strategyOutputSchema>;
export type CeoStage = z.infer<typeof ceoStageSchema>;

const roleSchema = z.object({
  role: strategyRoleSchema,
  title: z.string(),
  parent_role: strategyRoleSchema.nullable(),
  capabilities: z.array(z.string()),
});

const welcomeBriefSchema = z.object({
  headline: z.string(),
  next_steps: z.array(z.string()).min(1).max(5),
  suggested_prompts: z.array(z.string()).min(1).max(6),
});

const missionBriefSchema = z.object({
  mission_statement: z.string(),
  target_user: z.string(),
  problem: z.string(),
  differentiators: z.array(z.string()).min(1).max(5),
  assumptions: z.array(z.string()).max(5),
  unknowns: z.array(z.string()).max(5),
  suggested_replies: z.array(z.string()).min(1).max(5),
});

const questionBlockSchema = z.object({
  prompt: z.string(),
  options: z.array(z.string()).min(2).max(5),
  why_now: z.string(),
});

const strategyBlockSchema = z.object({
  first_release: z.string(),
  scope_boundary: z.array(z.string()),
  role_rationale: z.array(z.string()),
  roles: z.array(roleSchema).min(1).max(8),
  execution_sequence: z.array(z.string()).min(1).max(6),
  board_checkpoints: z.array(z.string()).min(1).max(5),
  key_risks: z.array(z.string()).min(1).max(5),
});

const statusBlockSchema = z.object({
  headline: z.string(),
  current_focus: z.array(z.string()).max(5),
  blockers: z.array(z.string()).max(4),
  next_actions: z.array(z.string()).max(5),
  board_requests: z.array(z.string()).max(4),
});

const sprintProposalBlockSchema = z.object({
  sprint_goal: z.string(),
  key_tasks: z.array(z.object({
    title: z.string(),
    assigned_role: strategyRoleSchema,
    priority: z.enum(["critical", "high", "medium", "low"]),
    depends_on: z.array(z.string()).max(4),
    rationale: z.string(),
  })).min(1).max(6),
  carried_forward: z.array(z.string()).max(4),
  risks: z.array(z.string()).max(4),
  rationale: z.string(),
});

export const ceoCardSchema = z.object({
  card_type: z.enum(["welcome_brief", "mission_brief", "clarifying_question", "strategy_proposal", "status_update", "sprint_proposal"]),
  stage: ceoStageSchema,
  title: z.string(),
  summary: z.string(),
  welcome: welcomeBriefSchema.nullable(),
  mission: missionBriefSchema.nullable(),
  strategy: strategyBlockSchema.nullable(),
  question: questionBlockSchema.nullable(),
  status: statusBlockSchema.nullable(),
  sprint_proposal: sprintProposalBlockSchema.nullable(),
  meeting: ceoMeetingIntentSchema,
});

export type CeoCard = z.infer<typeof ceoCardSchema>;

function summarizeChatMessages(messages: ChatMessage[]) {
  if (messages.length === 0) {
    return "No prior CEO-board chat yet.";
  }

  return messages.slice(-8).map((message) => {
    const speaker = message.role === "board"
      ? "Board"
      : message.role === "ceo"
        ? "CEO"
        : message.role === "agent"
          ? "Agent"
          : "System";
    const card = message.cardType ? ` [${message.cardType}]` : "";
    return `- ${speaker}${card}: ${message.content}`;
  }).join("\n");
}

function summarizeAgents(snapshot: CompanySnapshot) {
  if (snapshot.agents.length === 0) {
    return "No team hired yet.";
  }

  return snapshot.agents.map((agent) => `${agent.name} (${agent.role}) — ${agent.title}`).join("; ");
}

function summarizeHierarchy(snapshot: CompanySnapshot) {
  if (snapshot.hierarchy.length === 0) {
    return "No org chart defined yet.";
  }

  return snapshot.hierarchy.map((node) => `${node.role} -> ${node.parentNodeId ? "managed" : "top-level"}`).join("; ");
}

function summarizeTasks(snapshot: CompanySnapshot) {
  if (snapshot.tasks.length === 0) {
    return "No tasks created yet.";
  }

  return snapshot.tasks.slice(0, 8).map((task) => `${task.title} [${task.status}] (${task.assignedRole})`).join("; ");
}

function summarizeApprovals(snapshot: CompanySnapshot) {
  const pending = snapshot.approvals.filter((approval) => approval.status === "pending");
  if (pending.length === 0) {
    return "No pending approvals.";
  }

  return pending.map((approval) => `${approval.type}: ${approval.title}`).join("; ");
}

function summarizeMeetings(snapshot: CompanySnapshot) {
  if (snapshot.meetings.length === 0) {
    return "No meetings recorded yet.";
  }

  return snapshot.meetings.slice(0, 4).map((meeting) => `${meeting.type}: ${meeting.summary}`).join("; ");
}

export function inferCeoStage(snapshot: CompanySnapshot, executionStatus?: string): CeoStage {
  if (snapshot.company.id === "company_pending") {
    return "welcome";
  }

  // Between sprints: execution is done AND current sprint is completed AND we have agents
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  if (currentSprint?.status === "completed" && snapshot.agents.length > 0 && executionStatus === "done") {
    return "between_sprints";
  }

  if (snapshot.agents.length > 0 || snapshot.hierarchy.length > 0 || snapshot.tasks.length > 0 || snapshot.approvals.length > 0) {
    return "execution";
  }

  const recentCardTypes = snapshot.chatMessages
    .filter((message) => message.role === "ceo")
    .slice(-4)
    .map((message) => message.cardType);

  if (recentCardTypes.includes("strategy_proposal")) {
    return "kickoff";
  }

  if (snapshot.chatMessages.length >= 5) {
    return "team_design";
  }

  if (snapshot.chatMessages.length >= 2 || Boolean(snapshot.idea.currentDirection)) {
    return "idea_refinement";
  }

  return "welcome";
}

function buildSprintRetrospectiveContext(snapshot: CompanySnapshot): string {
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  if (!currentSprint) return "";

  const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === currentSprint.id);
  const completedTasks = sprintTasks.filter((t) => t.kind !== "follow_up" && t.status === "completed");
  const failedTasks = sprintTasks.filter((t) => t.status === "failed");
  const followUpTasks = snapshot.tasks.filter((t) => t.kind === "follow_up" && t.status === "created");

  const lines = [
    "",
    `## Sprint ${currentSprint.number} Retrospective`,
    `Sprint goal: ${currentSprint.goal}`,
    `Status: ${currentSprint.status}`,
    "",
    "### What was delivered",
    ...completedTasks.map((t) => `- ${t.title} (${t.assignedRole})`),
    ...(completedTasks.length === 0 ? ["- Nothing completed"] : []),
  ];

  if (failedTasks.length > 0) {
    lines.push("", "### What failed");
    for (const t of failedTasks) {
      lines.push(`- ${t.title} (${t.assignedRole}): ${t.verifierState?.feedback || "no details"}`);
    }
  }

  if (followUpTasks.length > 0) {
    lines.push("", "### Follow-up suggestions from task planner (not yet executed)");
    for (const t of followUpTasks) {
      lines.push(`- ${t.title} → ${t.assignedRole} (${t.priority})`);
    }
  }

  // Board feedback during sprint
  const sprintStartIdx = snapshot.chatMessages.findIndex((m) =>
    m.content.includes("Sprint") || m.content.includes("execution")
  );
  const recentBoardMessages = snapshot.chatMessages
    .filter((m) => m.role === "board")
    .slice(-5);
  if (recentBoardMessages.length > 0) {
    lines.push("", "### Board feedback during sprint");
    for (const m of recentBoardMessages) {
      lines.push(`- "${m.content.slice(0, 150)}"`);
    }
  }

  // Workspace state
  lines.push("", `### Workspace: code has been built in the company workspace across ${completedTasks.length} completed tasks.`);

  return lines.join("\n");
}

function buildSnapshotContext(snapshot: CompanySnapshot, executionStatus?: string) {
  return [
    `Stage: ${inferCeoStage(snapshot, executionStatus)}`,
    `Company name: ${snapshot.company.name}`,
    `Company status: ${snapshot.company.status}`,
    `Board goal: ${snapshot.company.goal || "Not captured yet"}`,
    `Core idea: ${snapshot.idea.coreIdea || "Not captured yet"}`,
    `Direction: ${snapshot.idea.currentDirection || "Not refined yet"}`,
    `Strategy title: ${snapshot.strategy.title}`,
    `Strategy summary: ${snapshot.strategy.summary}`,
    `Current sprint: ${snapshot.company.currentSprintNumber ?? "none"}`,
    `Hierarchy: ${summarizeHierarchy(snapshot)}`,
    `Agents: ${summarizeAgents(snapshot)}`,
    `Tasks: ${summarizeTasks(snapshot)}`,
    `Approvals: ${summarizeApprovals(snapshot)}`,
    `Recent meetings: ${summarizeMeetings(snapshot)}`,
    "Recent boardroom chat:",
    summarizeChatMessages(snapshot.chatMessages),
  ].join("\n");
}

export function buildCeoOperatingPrompt(snapshot: CompanySnapshot, executionStatus?: string) {
  const ceoSoul = getRoleSoul("ceo");
  const stage = inferCeoStage(snapshot, executionStatus);

  const lines = [
    ceoSoul.systemPrompt,
    "",
    "Operate like a strong founder-CEO with full visibility into company state, team shape, backlog posture, approvals, meetings, and recent board conversation.",
    "You do not answer like a plain chatbot. You guide the board through staged decisions and package decisions as crisp, interactive cards.",
    "Conversation rules:",
    "- Welcome stage: orient the board quickly and help them express the product clearly.",
    "- Idea refinement: synthesize the mission, identify assumptions, and ask only the highest-leverage question.",
    "- Team design: pressure-test scope and the minimum org needed to ship.",
    "- Kickoff: propose the first release, team shape, execution sequence, risks, and board checkpoints.",
    "- Execution: report like an operator. Reference real team, tasks, approvals, meetings, and blockers.",
    "- Between sprints: the prior sprint is complete. Analyze what was built, what failed, what the Board said, and what follow-up tasks the planner suggested. Propose Sprint N+1 using a sprint_proposal card. Assign tasks to specific roles. Define dependencies between tasks. Include a board_handoff task at the end.",
    "- Avoid generic filler. Be concise, opinionated, and operationally sharp.",
    "- Prefer tradeoffs and recommendations over vague brainstorming.",
    "- Never invent implementation details that are not grounded in company state.",
    "- Convergence: after 2-3 clarifying exchanges, stop asking and propose a strategy_proposal. Do not ask more than 3 clarifying questions total. If the board has given enough direction, converge immediately. The goal is a demoable first release, not perfect requirements.",
    "- One intent per response: either ASK a question or PROPOSE a strategy — never both. If you want board confirmation before proceeding, stop after the question. Do not answer your own question in the same message.",
    "",
    "Current company intelligence:",
    buildSnapshotContext(snapshot, executionStatus),
  ];

  // Append sprint retrospective when between sprints
  if (stage === "between_sprints") {
    lines.push(buildSprintRetrospectiveContext(snapshot));
  }

  return lines.join("\n");
}

export async function classifyCeoResponse(
  ceoText: string,
  snapshot: CompanySnapshot,
  executionStatus?: string,
): Promise<CeoCard> {
  const stage = inferCeoStage(snapshot, executionStatus);
  const systemPrompt = [
    "You are the CEO's structured boardroom formatter.",
    "Convert the CEO's free-text message into the single best interactive card for the board.",
    "The board should understand company state, next decisions, and execution implications within seconds.",
    "",
    "Available card types:",
    "- welcome_brief: opening orientation with suggested prompts.",
    "- mission_brief: synthesized mission, assumptions, unknowns, and suggested replies.",
    "- clarifying_question: one high-leverage question with concrete options and why it matters now.",
    "- strategy_proposal: first release, team shape, execution sequence, risks, and board checkpoints.",
    "- status_update: current focus, blockers, next actions, and any requests back to the board.",
    "- sprint_proposal: next sprint goal, key tasks with assigned roles and dependencies, carried items, risks, and rationale. Use ONLY when stage is between_sprints.",
    "",
    "Global rules:",
    "- Pick exactly one card_type.",
    "- Always set stage to the current stage or the next stage the CEO is guiding toward.",
    "- Keep title and summary executive-grade, not fluffy.",
    "- If a block does not apply, set it to null.",
    "- When the board can act immediately, provide suggested prompts, suggested replies, or concrete option buttons.",
    "- For welcome_brief: welcome must be filled.",
    "- For mission_brief: mission must be filled.",
    "- For clarifying_question: question must be filled and why_now must explain the decision leverage.",
    "- For strategy_proposal: strategy must include execution_sequence, board_checkpoints, and key_risks.",
    "- For status_update: status must include current_focus, blockers, next_actions, and board_requests.",
    "- For strategy_proposal: roles must contain the four core entries ceo, cto, pm, and developer exactly once.",
    "- You may add tester, ui_designer, marketing, and skills_lead when they materially improve delivery quality, launch readiness, or reusable leverage.",
    "- No duplicate roles. ceo has parent_role null. Every other role must have a valid parent_role.",
    "- Prefer this reporting shape unless there is a strong reason not to: ceo manages cto and marketing; cto manages pm, developer, tester, ui_designer, and skills_lead; pm may manage developer, tester, or ui_designer when product coordination is the point.",
    "- During idea refinement (welcome_brief, mission_brief, clarifying_question): set meeting.create to false and leave task_deltas empty. The chat is pure conversation — no side effects until the board approves a strategy.",
    "- For strategy_proposal: set meeting.create to false and leave task_deltas empty. The strategy card is a read-only proposal for board review. Agents, tasks, and meetings are created only after the board clicks Approve.",
    "- For sprint_proposal: sprint_proposal block must be filled with sprint_goal, key_tasks (each with title, assigned_role, priority, depends_on, rationale), carried_forward, risks, and rationale. Set all other blocks to null. Set meeting.create to false.",
    `Current stage hint: ${stage}`,
  ].join("\n");

  const userPrompt = [
    "## Company intelligence",
    buildSnapshotContext(snapshot),
    "",
    "## CEO message",
    ceoText,
  ].join("\n");

  return structuredCompletion(
    "ceoDeployment",
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    ceoCardSchema,
    "ceo_card",
    { temperature: 0.3 },
  );
}

export async function generateStrategy(snapshot: CompanySnapshot): Promise<StrategyOutput> {
  const userPrompt = [
    buildSnapshotContext(snapshot),
    "",
    "Produce a narrow strategy for a demoable first release.",
    "Propose a hierarchy with the four core roles: one ceo, one cto, one pm, and one developer.",
    "You may add any of these specialist roles if they are justified for the first release: tester, ui_designer, marketing, skills_lead.",
    "Use the smallest org that can still ship the first release with quality, launch readiness, and reusable operating leverage.",
    "No duplicate roles.",
    "Each role must have a parent_role except the ceo, which must be null.",
    "Preferred hierarchy: ceo manages cto and marketing. cto manages pm, developer, tester, ui_designer, and skills_lead. pm may manage developer, tester, or ui_designer when useful for delivery control.",
  ].join("\n");

  return structuredCompletion(
    "ceoDeployment",
    [
      { role: "system", content: buildCeoOperatingPrompt(snapshot) },
      { role: "user", content: userPrompt },
    ],
    strategyOutputSchema,
    "strategy_output",
  );
}
