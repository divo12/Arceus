import { z } from "zod";
import type { ChatMessage, CompanySnapshot } from "@arceus/contracts";
import { getRoleSoul, getAgentSkills } from "@arceus/company-runtime";
import { structuredCompletion, LlmTruncatedOutputError } from "../infra/azure-openai.js";

const strategyRoleSchema = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
// Mandatory hierarchy floor. Enforced deterministically after the LLM returns
// (see `enforceMandatoryRoles` below), NOT via Zod — so a drifting LLM never
// causes a retry/latency spike. Kept in lockstep with MANDATORY_ROLES in
// packages/company-runtime/src/roles.ts.
const coreStrategyRoles = ["ceo", "cto", "pm", "developer", "tester", "skills_lead"] as const;
type CoreStrategyRole = (typeof coreStrategyRoles)[number];
const ceoMeetingTypeSchema = z.enum(["ad_hoc", "sync", "escalation"]);
/** Valid CEO conversation stages. */
const ceoStageSchema = z.enum(["welcome", "idea_refinement", "team_design", "kickoff", "execution", "between_sprints"]);

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

// Roles arrive here already parsed against `strategyRoleSchema` (see the
// outer object schema below), so use the inferred type rather than a
// stringly-typed widener — that way `getRoleSoul` / `allowedDirectReports`
// accept the values without an `as any` cast at every call site.
type StrategyRole = z.infer<typeof strategyRoleSchema>;

function validateStrategyRoles(
  roles: { role: StrategyRole; parent_role: StrategyRole | null }[],
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

    // Enforce allowed reporting lines from ROLE_SOULS
    if (entry.parent_role !== null) {
      const parentSoul = getRoleSoul(entry.parent_role);
      if (parentSoul && !parentSoul.allowedDirectReports.includes(entry.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "parent_role"],
          message: `${entry.parent_role} cannot manage ${entry.role}. Allowed: ${parentSoul.allowedDirectReports.join(", ")}`,
        });
      }
    }
  });

  // Mandatory-role presence is enforced DETERMINISTICALLY by enforceMandatoryRoles()
  // after the LLM returns, not at schema-validation time. Keeping it out of Zod means
  // a drifting LLM never triggers a retry/latency spike — we just inject missing
  // roles server-side.
}

/** Schema for the structured strategy output produced by the CEO agent. */
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
type CeoStage = z.infer<typeof ceoStageSchema>;

type StrategyRoleEntry = StrategyOutput["roles"][number];

/**
 * Default role specs injected by `enforceMandatoryRoles` when the LLM omits
 * a mandatory role. Titles/capabilities mirror ROLE_SOULS defaults so behavior
 * is consistent regardless of whether the LLM produced the role or the server did.
 */
const MANDATORY_ROLE_DEFAULTS: Record<CoreStrategyRole, Omit<StrategyRoleEntry, "role">> = {
  ceo: { title: "Founder CEO", parent_role: null, capabilities: ["Board communication", "Strategic narrowing", "Hiring requests", "Meeting orchestration"] },
  cto: { title: "Chief Technology Officer", parent_role: "ceo", capabilities: ["Architecture planning", "Task decomposition", "Verification", "Technical escalation"] },
  pm: { title: "Product Manager", parent_role: "cto", capabilities: ["Sprint planning", "Backlog prioritization", "Cross-role coordination"] },
  developer: { title: "Full-Stack Developer", parent_role: "cto", capabilities: ["Feature implementation", "Frontend + backend code", "Bug fixing"] },
  tester: { title: "Quality Assurance Tester", parent_role: "cto", capabilities: ["End-to-end verification", "QA report authoring", "Regression coverage"] },
  skills_lead: { title: "Skills Lead", parent_role: "cto", capabilities: ["Skill authoring", "Playbook curation", "Workflow optimization"] },
};

/**
 * Deterministic mandatory-role enforcer. Guarantees tester + skills_lead
 * (and the other core roles) are present regardless of what the LLM produced.
 * Called after every strategy generation / classification path.
 */
function enforceMandatoryRoles(roles: StrategyRoleEntry[]): StrategyRoleEntry[] {
  const present = new Set(roles.map((r) => r.role));
  const result = [...roles];
  for (const core of coreStrategyRoles) {
    if (!present.has(core)) {
      const defaults = MANDATORY_ROLE_DEFAULTS[core];
      result.push({ role: core, ...defaults });
    }
  }
  return result;
}

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

/** Schema for structured CEO boardroom cards sent to the UI. */
const ceoCardSchema = z.object({
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

  return snapshot.meetings.slice(0, 4).map((meeting) => `${meeting.type}: ${meeting.title}`).join("; ");
}

/** Infer the current CEO conversation stage from company snapshot state. */
function inferCeoStage(snapshot: CompanySnapshot, executionStatus?: string): CeoStage {
  if (!snapshot.company.id) {
    return "welcome";
  }

  // Between sprints: execution is done AND current sprint is completed (or no sprint yet) AND we have agents
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  const noSprintYet = !snapshot.company.currentSprintId && snapshot.sprints.length === 0;
  if ((currentSprint?.status === "completed" || noSprintYet) && snapshot.agents.length > 0 && executionStatus === "done") {
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

  const recentBoardMessages = snapshot.chatMessages
    .filter((m) => m.role === "board")
    .slice(-5);
  if (recentBoardMessages.length > 0) {
    lines.push("", "### Board feedback during sprint");
    for (const m of recentBoardMessages) {
      lines.push(`- "${m.content.slice(0, 150)}"`);
    }
  }

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

/** Build the full system prompt for the CEO agent, including company context. */
export function buildCeoOperatingPrompt(snapshot: CompanySnapshot, executionStatus?: string) {
  const ceoSoul = getRoleSoul("ceo");
  const stage = inferCeoStage(snapshot, executionStatus);

  const lines = [
    ceoSoul.systemPrompt,
    getAgentSkills("ceo"),
    "",
    "Operate like a strong founder-CEO with full visibility into company state, team shape, backlog posture, approvals, meetings, and recent board conversation.",
    "You do not answer like a plain chatbot. You guide the board through staged decisions and package decisions as crisp, interactive cards.",
    "",
    "Spec 35 — Interactive cards via `chat_emit_card`:",
    "Use `chat_emit_card` for ALL structured interactive output. Available card types: idea_refine, name_suggest, hiring_slate, sprint_plan, decision, approval_request, memory_capture, meeting_summary.",
    "Emit ONE card per turn. The user's button click arrives as a synthetic user message before your next turn.",
    "",
    "Bootstrap sequence (when the company has no agents and no sprints yet):",
    "Drive the company from idea to first sprint by emitting cards IN THIS EXACT ORDER. You MUST NOT skip any step. Each step requires board approval before proceeding to the next:",
    "  1. Board gives you a raw idea → IMMEDIATELY call `chat_emit_card` with type `idea_refine`. Do not ask clarifying questions first. Reframe the idea into 2-3 concrete product directions and let the board pick.",
    "  2. Board picks a direction → call `chat_emit_card` with type `name_suggest`.",
    "  3. Board picks a name → call `chat_emit_card` with type `hiring_slate`. You MUST propose a team before any sprint. A sprint cannot exist without agents.",
    "  4. Board approves the team → ONLY THEN call `chat_emit_card` with type `sprint_plan`. NEVER emit sprint_plan if there are 0 agents in the company.",
    "",
    "Card type reference:",
    "  - `idea_refine` — call when the user describes a raw idea. Payload: { originalIdea, reframings: [{id,title,summary}, ...] }. ALWAYS emit this on the FIRST message containing a product idea.",
    "  - `name_suggest` — call after the idea is locked. Payload: { suggestions: [{name, rationale?}, ...], allowWriteIn: true }.",
    "  - `hiring_slate` — call after strategy/team is discussed. Payload: { roles: [{role, displayName, title?, rationale?}, ...] }.",
    "  - `sprint_plan` — call after hiring is approved. Payload: { sprintNumber, goal, tasks: [{title, kind?, assignedRole?}, ...] }.",
    "  - `decision` — call when you need the board to pick from options. Payload: { question, options: [{id, label, description?}, ...] }.",
    "Do NOT narrate the card payload in plaintext — emit it via the tool. A short conversational sentence in the chat reply is fine ('Here's how I'm reading it:'), but the card carries the structured content.",
    "When you DO call chat_emit_card, keep your plaintext reply to ONE short sentence of framing — never restate the question or the options that the card already shows.",
    "For everything else (status updates, questions, strategy discussion, mission briefings) — just reply in plaintext. Your text is rendered as markdown, so use headings, lists, bold, etc. for structure.",
    "",
    "Conversation rules:",
    "- Welcome stage: orient the board quickly and help them express the product clearly.",
    "- Idea refinement: synthesize the mission, identify assumptions, and ask only the highest-leverage question.",
    "- Team design: pressure-test scope and the minimum org needed to ship.",
    "- Kickoff: propose the first release, team shape, execution sequence, risks, and board checkpoints.",
    "- Execution: report like an operator. Reference real team, tasks, approvals, meetings, and blockers.",
    "- Between sprints: the prior sprint is complete. Analyze what was built, what failed, what the Board said, and what follow-up tasks the planner suggested. Propose Sprint N+1 using `chat_emit_card` with type `sprint_plan`. Assign tasks to specific roles. Define dependencies between tasks. The system will automatically add a CTO review step at the end of the pipeline.",
    "- Avoid generic filler. Be concise, opinionated, and operationally sharp.",
    "- Prefer tradeoffs and recommendations over vague brainstorming.",
    "- Never invent implementation details that are not grounded in company state.",
    "- Convergence: after 2-3 clarifying exchanges, stop asking and propose a strategy. Do not ask more than 3 clarifying questions total. If the board has given enough direction, converge immediately. The goal is a demoable first release, not perfect requirements.",
    "- One intent per response: either ASK a question or PROPOSE a strategy — never both. If you want board confirmation before proceeding, stop after the question. Do not answer your own question in the same message.",
    "",
    "Current company intelligence:",
    buildSnapshotContext(snapshot, executionStatus),
  ];

  if (stage === "between_sprints") {
    lines.push(buildSprintRetrospectiveContext(snapshot));
  }

  return lines.join("\n");
}

/**
 * Classify a free-text CEO response into a structured boardroom card.
 * Retries with a brevity directive on truncation; falls back to a status_update card.
 */
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
    "- MANDATORY reporting lines: ceo manages cto and marketing ONLY. cto manages pm, developer, tester, ui_designer, and skills_lead. pm may manage developer, tester, or ui_designer. Never assign pm, developer, tester, ui_designer, or skills_lead directly under ceo.",
    "- During idea refinement (welcome_brief, mission_brief, clarifying_question): set meeting.create to false and leave task_deltas empty. The chat is pure conversation — no side effects until the board approves a strategy.",
    "- For strategy_proposal: set meeting.create to false and leave task_deltas empty. The strategy card is a read-only proposal for board review. Agents, tasks, and meetings are created only after the board clicks Approve.",
    "- For sprint_proposal: sprint_proposal block must be filled with sprint_goal, key_tasks (each with title, assigned_role, priority, depends_on, rationale), carried_forward, risks, and rationale. Set all other blocks to null. Set meeting.create to false.",
    `Current stage hint: ${stage}`,
  ].join("\n");

  const userPrompt = [
    "## Company intelligence",
    buildSnapshotContext(snapshot, executionStatus),
    "",
    "## CEO message",
    ceoText,
  ].join("\n");

  const runClassifier = async (extraSystem?: string) => {
    const systemContent = extraSystem ? `${systemPrompt}\n\n${extraSystem}` : systemPrompt;
    return structuredCompletion(
      "ceoDeployment",
      [
        { role: "system", content: systemContent },
        { role: "user", content: userPrompt },
      ],
      ceoCardSchema,
      "ceo_card",
      { temperature: 0.3 },
    );
  };

  let card: CeoCard;
  try {
    card = await runClassifier();
  } catch (err) {
    // Truncation or malformed-JSON responses blow up both the strict json_schema
    // path and (occasionally) the strict validator. Retry once with an explicit
    // brevity directive so the classifier can finish within the token budget.
    const isTruncated = err instanceof LlmTruncatedOutputError;
    const isSyntax = err instanceof SyntaxError || (err instanceof Error && /JSON/i.test(err.message));
    if (!isTruncated && !isSyntax) throw err;

    console.warn(
      `[ceo_card] classifier ${isTruncated ? "truncated" : "malformed-JSON"}; retrying with compact directive:`,
      err instanceof Error ? err.message : err,
    );

    try {
      card = await runClassifier(
        [
          "BREVITY RULES (response was previously truncated — you MUST fit in 4k tokens):",
          "- Limit any arrays (key_tasks, suggested_prompts, roles, board_checkpoints, risks) to the minimum viable count: prefer 3-5 items max.",
          "- Keep every string under 280 characters. No paragraphs.",
          "- Do not restate the CEO message verbatim. Extract structure only.",
          "- If the CEO message is long, summarize aggressively and drop low-value fields to null.",
        ].join("\n"),
      );
    } catch (retryErr) {
      // Final safety net: produce a minimal status_update card so chat still
      // makes forward progress. Without this, a persistently-truncating CEO
      // response would loop the heartbeat forever and never publish anything.
      console.error(
        "[ceo_card] classifier retry also failed — emitting fallback status_update card:",
        retryErr instanceof Error ? retryErr.message : retryErr,
      );
      const fallback: CeoCard = {
        card_type: "status_update",
        stage,
        title: "CEO update (fallback)",
        summary: ceoText.slice(0, 400),
        welcome: null,
        mission: null,
        strategy: null,
        question: null,
        status: {
          headline: "CEO classifier failed — emitting raw update",
          current_focus: [ceoText.slice(0, 280)],
          blockers: ["Structured classifier produced malformed/truncated output"],
          next_actions: [],
          board_requests: [],
        },
        sprint_proposal: null,
        meeting: { create: false, type: null, summary: "", rationale: "", task_deltas: [] },
      };
      return fallback;
    }
  }

  // Deterministic mandatory-role injection for strategy_proposal cards — never
  // trust the LLM to include tester + skills_lead. This guarantees the floor
  // without round-tripping through a Zod-violation retry.
  if (card.card_type === "strategy_proposal" && card.strategy) {
    return { ...card, strategy: { ...card.strategy, roles: enforceMandatoryRoles(card.strategy.roles) } };
  }
  return card;
}

/** Generate a structured strategy proposal from the current company snapshot. */
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
    "MANDATORY hierarchy: ceo manages cto and marketing ONLY. cto manages pm, developer, tester, ui_designer, and skills_lead. pm may manage developer, tester, or ui_designer. Never place pm, developer, tester, ui_designer, or skills_lead directly under ceo.",
  ].join("\n");

  const messages = [
    { role: "system" as const, content: buildCeoOperatingPrompt(snapshot) },
    { role: "user" as const, content: userPrompt },
  ];

  try {
    const raw = await structuredCompletion(
      "ceoDeployment",
      messages,
      strategyOutputSchema,
      "strategy_output",
    );
    return { ...raw, roles: enforceMandatoryRoles(raw.roles) };
  } catch (err: unknown) {
    // Self-heal hierarchy violations: retry once with the specific violations
    // echoed back to the model. This unblocks single-token LLM drifts without
    // loosening the policy schema.
    const zodIssues = extractZodIssues(err);
    const hierarchyViolations = zodIssues.filter(
      (issue) => Array.isArray(issue.path) && issue.path.includes("parent_role"),
    );
    if (hierarchyViolations.length === 0) throw err;

    const violationLines = hierarchyViolations
      .map((issue) => `- roles[${issue.path[1]}].parent_role: ${issue.message}`)
      .join("\n");

    const retryPrompt = [
      "Your previous strategy violated hierarchy policy:",
      violationLines,
      "",
      "Re-emit the strategy with corrected parent_role values. Each parent_role MUST",
      "appear in that manager's allowed list. Do not change role names — only fix",
      "parent_role fields as needed. Keep all other content identical.",
    ].join("\n");

    const retried = await structuredCompletion(
      "ceoDeployment",
      [...messages, { role: "user" as const, content: retryPrompt }],
      strategyOutputSchema,
      "strategy_output",
    );
    return { ...retried, roles: enforceMandatoryRoles(retried.roles) };
  }
}

/** Extract Zod issues from a thrown error, whether direct ZodError or wrapped. */
function extractZodIssues(err: unknown): { path: (string | number)[]; message: string }[] {
  if (err && typeof err === "object") {
    const anyErr = err as { issues?: unknown; cause?: { issues?: unknown } };
    const issues = (anyErr.issues ?? anyErr.cause?.issues);
    if (Array.isArray(issues)) {
      return issues as { path: (string | number)[]; message: string }[];
    }
  }
  return [];
}
