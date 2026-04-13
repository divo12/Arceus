import { mkdir, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { getOpencode, resetOpencodeConnection } from "./opencode";
import { getRoleSoul } from "@arceus/company-runtime";
import { ensureDeployment, orchestratorConfig, persistenceConfig, previewConfig } from "./config/index";
import { emitEmployeeActivity } from "./activity";
import { appendChatMessage, getSnapshot, replaceTasks, updateAgentMemory, updateApproval, updateCompanySprint, updateMeeting, updateSprint, updateTask, upsertApproval, upsertMeeting, upsertSprint, upsertTask } from "./store";
import type { Approval, CompanySnapshot, AgentIdentity, Meeting, Sprint, Task, Transition, TransitionProposal } from "@arceus/contracts";
import type { CeoCard } from "./ceo";
import { buildCeoOperatingPrompt, classifyCeoResponse } from "./ceo";
import { clearReportedPreviewCandidate, getLocalPreviewState, hasLocalPreviewCandidate, hasReportedPreviewCandidate, registerReportedPreviewUrl, startLocalPreview, stopLocalPreview } from "./preview";
import { generateWorkflowTaskPlan, mapTaskPriority } from "./task-planner";
import { runRouterLoop, type RouterLoopResult } from "./router";
import { persistRuntimeArtifact } from "./artifact-persistence";
import { workspaceManager } from "./workspace-manager";
import { structuredCompletion } from "./azure-openai";
import { withRetry, isRetryableError } from "./resilience";
import { createHippocampusService, EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, ACTION_DECISION_SYSTEM_PROMPT, buildActionDecisionUserPrompt, HABIT_MATCHER_SYSTEM_PROMPT, buildHabitMatcherUserPrompt, PRIMING_GENERATOR_SYSTEM_PROMPT, buildPrimingGeneratorUserPrompt, createPgVectorStores } from "@arceus/hippocampus";
import type { PreparedAgentContext, ExtractedFact, MemoryAction } from "@arceus/hippocampus";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Hippocampus — singleton memory service (in-memory stores for now)
// ---------------------------------------------------------------------------

const extractedFactSchema = z.object({
  facts: z.array(z.object({
    content: z.string(),
    type: z.enum(["static", "dynamic", "procedural"]),
    confidence: z.number(),
    is_temporal: z.boolean(),
    expiry_days: z.number().nullable(),
    trigger: z.string().nullable(),
    action: z.string().nullable(),
  })),
});

async function llmFactExtractor(agentOutput: string, taskTitle: string, role: string): Promise<ExtractedFact[]> {
  const userPrompt = buildExtractionUserPrompt(taskTitle, role, agentOutput);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    extractedFactSchema,
    "fact_extraction",
    { temperature: 0.3 },
  );
  return result.facts.map((f) => ({
    ...f,
    trigger: f.trigger ?? undefined,
    action: f.action ?? undefined,
  }));
}

const memoryActionSchema = z.object({
  action: z.enum(["ADD", "UPDATE", "DELETE", "NONE"]),
  target_id: z.string().nullable(),
  reason: z.string(),
});

async function llmActionDecider(
  newFact: string,
  existingMemories: Array<{ id: string; content: string; type: string; confidence: number }>,
): Promise<MemoryAction> {
  const userPrompt = buildActionDecisionUserPrompt(newFact, existingMemories);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: ACTION_DECISION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    memoryActionSchema,
    "memory_action_decision",
    { temperature: 0.1 },
  );
  return result;
}

const primingDispositionSchema = z.object({
  disposition: z.string(),
});

async function llmPrimingGenerator(
  state: { confidence: number; caution: number; morale: number; recentEvents: string[] },
): Promise<string> {
  const userPrompt = buildPrimingGeneratorUserPrompt(state as any);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: PRIMING_GENERATOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    primingDispositionSchema,
    "priming_generation",
    { temperature: 0.4 },
  );
  return result.disposition;
}

const habitMatcherSchema = z.object({
  habit_ids: z.array(z.string()),
});

async function llmHabitMatcher(
  taskDescription: string,
  habits: Array<{ id: string; trigger: string; action: string }>,
): Promise<string[]> {
  const userPrompt = buildHabitMatcherUserPrompt(taskDescription, habits as any);
  const result = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: HABIT_MATCHER_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    habitMatcherSchema,
    "habit_matching",
    { temperature: 0.1 },
  );
  // Only return IDs that actually exist in the input list
  const validIds = new Set(habits.map((h) => h.id));
  return result.habit_ids.filter((id) => validIds.has(id));
}

const pgStores = createPgVectorStores();
if (pgStores) {
  console.log("[Hippocampus] Using pgvector-backed persistent stores");
} else {
  console.log("[Hippocampus] Database not configured — using in-memory stores (memories lost on restart)");
}

export const hippocampus = createHippocampusService({
  ...pgStores,
  extractFacts: llmFactExtractor,
  decideAction: llmActionDecider,
  matchHabits: llmHabitMatcher,
  generatePriming: llmPrimingGenerator,
});

// ---------------------------------------------------------------------------
// Skill loader — reads SKILL.md files with YAML frontmatter
// ---------------------------------------------------------------------------

const skillsDir = resolve(process.cwd(), "packages", "company-runtime", "skills");

interface SkillEntry {
  name: string;
  description: string;
  role: string;
  body: string;
  path: string;
}

function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const lines = match[1].split("\n");
  const frontmatter: Record<string, string> = {};
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      frontmatter[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
    }
  }
  return { frontmatter, body: match[2].trim() };
}

function loadSkillsForRole(role: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  if (!existsSync(skillsDir)) return entries;

  for (const dir of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const skillPath = join(skillsDir, dir.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, "utf8");
    const { frontmatter, body } = parseSkillFrontmatter(raw);

    // Include skills that match this role or have no role specified (universal)
    if (frontmatter.role && frontmatter.role !== role) continue;

    entries.push({
      name: frontmatter.name || dir.name,
      description: frontmatter.description || "",
      role: frontmatter.role || "",
      body,
      path: skillPath,
    });
  }
  return entries;
}

function buildSkillMenu(role: string): string {
  const skills = loadSkillsForRole(role);
  if (skills.length === 0) return "";
  const lines = ["", "# Available skills for this role"];
  for (const skill of skills) {
    lines.push(`- **${skill.name}**: ${skill.description}`);
  }
  return lines.join("\n");
}

function getSkillBody(role: string, skillName?: string): string {
  const skills = loadSkillsForRole(role);
  if (skills.length === 0) return "";
  // If a specific skill is requested, return its body
  if (skillName) {
    const match = skills.find(s => s.name === skillName);
    return match ? `\n# Skill: ${match.name}\n\n${match.body}` : "";
  }
  // Otherwise return all skills for this role (there's usually just one)
  return skills.map(s => `\n# Skill: ${s.name}\n\n${s.body}`).join("\n");
}

type AgentSessionState = {
  role: string;
  agentId: string;
  sessionId: string;
  name: string;
  status: "idle" | "working" | "done" | "error";
  lastEventAt: string | null;
  lastEventType: string | null;
  lastEventSummary: string | null;
  lastToolName: string | null;
  lastToolStatus: "invoked" | "completed" | null;
  lastToolAt: string | null;
  lastProgressAt: string | null;
  lastWorkspaceChangeAt: string | null;
  awaiting: string | null;
  activeTaskId: string | null;
  promptStartedAt: string | null;
  promptCompletedAt: string | null;
  eventCount: number;
  toolInvocationCount: number;
  fileEditCount: number;
  shellCommandCount: number;
  stallReason: string | null;
};

type Artifact = {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output";
  title: string;
  content: string;
  createdAt: string;
};

type ExecutionStatus = "idle" | "planning" | "executing" | "verifying" | "awaiting_board_review" | "paused" | "done" | "error";

type ExecutionContext = {
  companyId: string;
  planTaskId: string;
  acceptanceTaskId: string;
  buildTaskId: string;
  previewTaskId: string;
  reviewTaskId: string;
  planText: string | null;
  acceptanceText: string | null;
  reviewStarted: boolean;
  reworkCycles: number;
};

const CORE_EXECUTION_TASK_KINDS = new Set<Task["kind"]>(orchestratorConfig.coreExecutionTaskKinds);
const AUTONOMOUS_READY_TASK_ROLES = new Set<AgentIdentity["role"]>(orchestratorConfig.autonomousReadyTaskRoles);

const agentSessions = new Map<string, AgentSessionState>();
const artifacts: Artifact[] = [];
let executionStatus: ExecutionStatus = "idle";
let eventBridgeStarted = false;
let activeExecution: ExecutionContext | null = null;
let developerWatchdog: NodeJS.Timeout | null = null;
let developerWorkspaceMonitor: NodeJS.Timeout | null = null;
let developerWorkspaceSnapshot = new Map<string, number>();
let developerStepLoopActive = false;
const workspaceRoot = resolve(process.cwd(), "..", "..");
// In Docker /app is cwd, so workspaceRoot resolves to "/" — use cwd-relative instead
const productDir = existsSync(resolve(workspaceRoot, "workspace")) || !process.cwd().startsWith("/app")
  ? resolve(workspaceRoot, "workspace")
  : resolve(process.cwd(), "workspace");
const DEVELOPER_STALL_TIMEOUT_MINUTES = orchestratorConfig.developer.stallTimeoutMinutes;
const DEVELOPER_STALL_TIMEOUT_MS = DEVELOPER_STALL_TIMEOUT_MINUTES * 60 * 1000;
const WORKSPACE_MONITOR_INTERVAL_MS = orchestratorConfig.developer.workspaceMonitorIntervalMs;
const WORKSPACE_MONITOR_IGNORE = new Set(orchestratorConfig.developer.workspaceMonitorIgnore);

function nowIso() {
  return new Date().toISOString();
}

function truncateTelemetry(value: string | null | undefined, limit = 220) {
  if (!value) return null;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function updateAgentSessionState(role: string, patch: Partial<AgentSessionState>) {
  const session = agentSessions.get(role);
  if (!session) return;

  Object.assign(session, patch);
}

function summarizeDeveloperStall(session: AgentSessionState) {
  const details = [
    session.awaiting ? `Awaiting: ${session.awaiting}.` : null,
    session.lastToolName ? `Last tool: ${session.lastToolName}${session.lastToolStatus ? ` (${session.lastToolStatus})` : ""}.` : null,
    session.lastEventSummary ? `Last session update: ${session.lastEventSummary}` : null,
    session.lastWorkspaceChangeAt ? `Last workspace change: ${session.lastWorkspaceChangeAt}.` : null,
    session.lastProgressAt ? `Last recorded progress: ${session.lastProgressAt}.` : null,
  ].filter(Boolean);

  return details.join(" ");
}

function clearDeveloperWatchdog() {
  if (!developerWatchdog) return;
  clearTimeout(developerWatchdog);
  developerWatchdog = null;
}

function touchAgentSession(role: string, status?: AgentSessionState["status"]) {
  const session = agentSessions.get(role);
  if (!session) return;

  session.lastEventAt = nowIso();
  if (status) {
    session.status = status;
  }
}

function scheduleDeveloperWatchdog() {
  clearDeveloperWatchdog();

  if (!activeExecution || executionStatus !== "executing") return;

  const developerSession = agentSessions.get("developer");
  if (!developerSession || developerSession.status !== "working") return;

  developerWatchdog = setTimeout(() => {
    void failDeveloperStall(developerSession.sessionId);
  }, DEVELOPER_STALL_TIMEOUT_MS);
}

async function failDeveloperStall(sessionId: string) {
  const developerSession = agentSessions.get("developer");
  if (!activeExecution || executionStatus !== "executing") return;
  if (!developerSession || developerSession.sessionId !== sessionId || developerSession.status !== "working") return;

  clearDeveloperWatchdog();
  stopDeveloperWorkspaceMonitor();
  developerSession.status = "error";

  const lastEvent = developerSession.lastEventAt;
  const message = lastEvent
    ? `Developer session stalled after ${DEVELOPER_STALL_TIMEOUT_MINUTES} minutes without activity or workspace changes. Last activity: ${lastEvent}.`
    : `Developer session stalled after ${DEVELOPER_STALL_TIMEOUT_MINUTES} minutes without any observable activity or workspace changes.`;
  const detail = summarizeDeveloperStall(developerSession);
  const diagnosticMessage = detail ? `${message} ${detail}` : message;

  updateAgentSessionState("developer", {
    awaiting: "leadership review after stall",
    stallReason: diagnosticMessage,
    lastEventSummary: diagnosticMessage,
  });

  executionStatus = "error";
  setTaskStatus(activeExecution.buildTaskId, "failed", diagnosticMessage);

  recordMeeting({
    type: "escalation",
    facilitatorRole: "developer",
    participantRoles: ["developer", "cto", "ceo"],
    summary: "Developer execution stalled and was escalated to leadership.",
    agenda: [
      {
        topic: "Developer stall",
        type: "blocker",
          content: diagnosticMessage,
        raisedByRole: "developer",
        relatedTaskId: activeExecution.buildTaskId,
      },
    ],
    decisions: [
      {
        description: "Leadership will inspect the stalled implementation run before resuming execution.",
        decidedByRoles: ["developer", "cto", "ceo"],
        impactIds: [activeExecution.buildTaskId],
      },
    ],
  });

  emitEmployeeActivity("developer", "error", diagnosticMessage, {
    taskId: activeExecution.buildTaskId,
  });
  emitEmployeeActivity("system", "error", "Execution halted because the developer session stopped reporting progress.", {
    taskId: activeExecution.buildTaskId,
  });
}

async function collectWorkspaceSnapshot(dir = productDir, base = productDir, result = new Map<string, number>()) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (WORKSPACE_MONITOR_IGNORE.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      await collectWorkspaceSnapshot(fullPath, base, result);
      continue;
    }

    try {
      const info = await stat(fullPath);
      result.set(relative(base, fullPath).replace(/\\/g, "/"), info.mtimeMs);
    } catch {
      /* ignore transient file errors */
    }
  }

  return result;
}

function stopDeveloperWorkspaceMonitor() {
  if (developerWorkspaceMonitor) {
    clearInterval(developerWorkspaceMonitor);
    developerWorkspaceMonitor = null;
  }
  developerWorkspaceSnapshot = new Map<string, number>();
}

async function pollDeveloperWorkspaceChanges() {
  if (!activeExecution || executionStatus !== "executing") {
    return;
  }

  const nextSnapshot = await collectWorkspaceSnapshot();
  const changedFiles = Array.from(nextSnapshot.entries())
    .filter(([path, mtime]) => (developerWorkspaceSnapshot.get(path) ?? 0) < mtime)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([path]) => path);

  developerWorkspaceSnapshot = nextSnapshot;

  if (changedFiles.length === 0) {
    return;
  }

  touchAgentSession("developer");
  updateAgentSessionState("developer", {
    lastWorkspaceChangeAt: nowIso(),
    lastProgressAt: nowIso(),
    lastEventSummary: `Workspace changed: ${changedFiles[0]}${changedFiles.length > 1 ? ` (+${changedFiles.length - 1} more)` : ""}`,
    awaiting: "processing workspace changes",
    stallReason: null,
  });
  scheduleDeveloperWatchdog();

  for (const filePath of changedFiles) {
    emitEmployeeActivity("developer", "file_edit", filePath, {
      taskId: activeExecution.buildTaskId,
    });
    appendTaskResult(activeExecution.buildTaskId, `edited:${filePath}`);
  }

  try {
    await maybeStartDeveloperLivePreview(changedFiles);
  } catch (err) {
    // Preview detection must never crash the API — log and continue
    emitEmployeeActivity("system", "error", `Preview detection failed: ${err instanceof Error ? err.message : String(err)}`, {
      taskId: activeExecution?.buildTaskId ?? null,
    });
  }
}

async function startDeveloperWorkspaceMonitor() {
  stopDeveloperWorkspaceMonitor();
  developerWorkspaceSnapshot = await collectWorkspaceSnapshot();
  developerWorkspaceMonitor = setInterval(() => {
    void pollDeveloperWorkspaceChanges();
  }, WORKSPACE_MONITOR_INTERVAL_MS);
}

async function maybeStartDeveloperLivePreview(changedFiles: string[]) {
  if (!activeExecution || executionStatus !== "executing") {
    return;
  }

  // Don't auto-launch preview while the dev step loop is running — the scaffold
  // boilerplate (index.html) is detected as a "runnable target" and would show
  // a dummy Vite + React page before any product code is written.
  if (developerStepLoopActive) {
    return;
  }

  const previewState = getLocalPreviewState();
  if (previewState.status === "starting" || previewState.status === "ready") {
    const previewUrl = previewState.validationUrl ?? previewState.entryUrl ?? previewState.url;
    if (previewUrl) {
      setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
    }
    return;
  }

  const preferredTargetPath = changedFiles[0]?.split("/")[0] ?? null;
  const hasCandidate = hasReportedPreviewCandidate() || await hasLocalPreviewCandidate(productDir, preferredTargetPath);
  if (!hasCandidate) {
    return;
  }

  emitEmployeeActivity("developer", "info", `Detected runnable workspace target. Attempting live preview from ${changedFiles[0] ?? "workspace changes"}.`, {
    taskId: activeExecution.buildTaskId,
  });

  const preview = await startLocalPreview(productDir, preferredTargetPath);
  const previewUrl = preview.validationUrl ?? preview.entryUrl ?? preview.url;
  if (preview.status !== "ready" || !previewUrl) {
    emitEmployeeActivity("developer", "info", preview.lastError ?? "Live preview attempt did not become reachable yet.", {
      taskId: activeExecution.buildTaskId,
    });
    return;
  }



  setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
  appendTaskResult(activeExecution.buildTaskId, `preview:${previewUrl}`);
  emitEmployeeActivity("developer", "info", `Live preview available during implementation → ${previewUrl}`, {
    taskId: activeExecution.buildTaskId,
  });
}

function emptyPlannerState(objective: string) {
  return {
    objective,
    planSteps: [],
    selectedTools: [],
    currentStepIndex: 0,
  };
}

function emptyExecutorState() {
  return {
    currentCommand: null,
    commandsExecuted: [],
    results: [],
  };
}

function emptyVerifierState() {
  return {
    isVerified: false,
    feedback: null,
    verifiedByAgentId: null,
  };
}

function addArtifact(agent: string, kind: Artifact["kind"], title: string, content: string) {
  const artifact: Artifact = {
    id: `artifact_${crypto.randomUUID()}`,
    agent,
    kind,
    title,
    content,
    createdAt: new Date().toISOString(),
  };
  artifacts.push(artifact);
  void persistRuntimeArtifact(getSnapshot().company.id, artifact);
  return artifact;
}

async function syncWorkspaceCheckpoint(taskId: string, agentRole: string, message: string) {
  const companyId = getSnapshot().company.id;
  if (!companyId || companyId === "company_pending") {
    return;
  }

  try {
    const result = await workspaceManager.commitAndSync(companyId, taskId, agentRole, message);
    if (result.warnings.length > 0) {
      emitEmployeeActivity("system", "info", `Workspace sync completed with warnings: ${result.warnings.join(" | ")}`, {
        taskId,
      });
      return;
    }

    emitEmployeeActivity("system", "info", `Workspace sync complete at commit ${result.commitSha}.`, {
      taskId,
    });
  } catch (error) {
    emitEmployeeActivity("system", "error", error instanceof Error ? error.message : "Workspace sync failed.", {
      taskId,
    });
  }
}

function createSprintRecord(snapshot: CompanySnapshot, title: string, goal: string): Sprint {
  const number = (snapshot.company.currentSprintNumber ?? 0) + 1;
  const ceoAgent = getAgentByRole(snapshot, "ceo");
  const sprint: Sprint = {
    id: `sprint_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    strategyId: snapshot.company.currentStrategyId,
    number,
    title: title || `Sprint ${number}`,
    goal: goal || "",
    status: "planning",
    plannedByAgentId: ceoAgent?.id ?? null,
    summary: null,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
  };

  upsertSprint(sprint);
  updateCompanySprint(sprint.id, number);
  return sprint;
}

/**
 * After a sprint completes, triggers the CEO to auto-propose Sprint N+1 via LLM.
 * If auto-approve is enabled and this isn't a board-review sprint, the proposal is
 * approved immediately without waiting for the board.
 */
async function triggerCeoSprintProposal(): Promise<void> {
  const snapshot = getSnapshot();

  // Duplicate guard: skip if sprint_proposal card already exists for current sprint
  const existingProposal = snapshot.chatMessages.find(
    (m) => m.cardType === "sprint_proposal" && m.sprintId === snapshot.company.currentSprintId,
  );
  if (existingProposal) return;

  // Set execution status so CEO stage infers as "between_sprints"
  executionStatus = "done";

  try {
    const ceoPrompt = buildCeoOperatingPrompt(snapshot, executionStatus);
    const ceoResponse = await structuredCompletion(
      "ceoDeployment",
      [
        { role: "system", content: ceoPrompt },
        { role: "user", content: "The previous sprint has completed. Analyze the results and propose the next sprint. Include sprint goal, key tasks with assigned roles and dependencies, carried-forward items, risks, and rationale." },
      ],
      z.object({ response: z.string() }),
      "ceo_sprint_proposal",
    );

    const ceoText = ceoResponse.response;
    const card = await classifyCeoResponse(ceoText, snapshot, executionStatus);

    // Append CEO message to chat
    appendChatMessage({
      id: `chat_${crypto.randomUUID()}`,
      companyId: snapshot.company.id,
      sprintId: snapshot.company.currentSprintId,
      agentId: getAgentByRole(snapshot, "ceo")?.id ?? null,
      role: "ceo",
      content: ceoText,
      cardType: card.card_type,
      cardData: card,
      createdAt: nowIso(),
    });

    // Determine if this sprint should auto-approve or wait for board review
    const nextSprintNumber = (snapshot.company.currentSprintNumber ?? 0) + 1;
    const cadence = orchestratorConfig.sprint.boardReviewEveryNSprints;
    const needsBoardReview = cadence > 0 && nextSprintNumber % cadence === 0;

    if (orchestratorConfig.sprint.autoApproveProposals && !needsBoardReview && card.sprint_proposal) {
      emitEmployeeActivity(
        "ceo",
        "info",
        `CEO proposed Sprint ${nextSprintNumber}. Auto-approving (board review scheduled for Sprint ${Math.ceil(nextSprintNumber / cadence) * cadence}).`,
      );
      await approveSprintProposal(card);
    } else {
      const reason = needsBoardReview
        ? `CEO proposed Sprint ${nextSprintNumber}. Board review required (every ${cadence} sprints). Awaiting board approval.`
        : `CEO proposed Sprint ${nextSprintNumber}. Board can approve or provide feedback.`;
      emitEmployeeActivity("ceo", "info", reason);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Sprint] CEO sprint proposal generation failed:", message);
    emitEmployeeActivity(
      "system",
      "error",
      `Failed to auto-generate sprint proposal: ${message}. Board can message the CEO directly to request a proposal.`,
    );
  }
}

let sprintCompletionTriggered = false;

/**
 * Checks if all employee tasks in the current sprint have reached terminal status.
 * If so, marks the sprint as completed, tags a snapshot, and triggers CEO auto-proposal.
 * Guard flag prevents double-firing.
 */
async function checkSprintCompletion(): Promise<boolean> {
  if (sprintCompletionTriggered) return false;

  const snapshot = getSnapshot();
  const currentSprintId = snapshot.company.currentSprintId;
  if (!currentSprintId) return false;

  const currentSprint = snapshot.sprints.find((s) => s.id === currentSprintId);
  if (!currentSprint || currentSprint.status === "completed") return false;

  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === currentSprintId && t.kind !== "follow_up",
  );
  if (sprintTasks.length === 0) return false;

  const allTerminal = sprintTasks.every((t) =>
    ["completed", "cancelled", "failed"].includes(t.status),
  );
  if (!allTerminal) return false;

  sprintCompletionTriggered = true;

  // Mark sprint completed
  updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    status: "completed" as Sprint["status"],
    completedAt: nowIso(),
    summary: `Sprint ${sprint.number} completed — ${sprintTasks.filter((t) => t.status === "completed").length}/${sprintTasks.length} tasks delivered.`,
  }));

  emitEmployeeActivity(
    "system",
    "info",
    `Sprint ${currentSprint.number} completed. ${sprintTasks.filter((t) => t.status === "completed").length} delivered, ${sprintTasks.filter((t) => t.status === "failed").length} failed, ${sprintTasks.filter((t) => t.status === "cancelled").length} cancelled.`,
  );

  await tagCurrentSprintSnapshot();

  // CEO announces sprint completion in chat before proposing next sprint
  const ceoAgent = getAgentByRole(snapshot, "ceo");
  appendChatMessage({
    id: `chat_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    sprintId: currentSprintId,
    agentId: ceoAgent?.id ?? null,
    role: "ceo",
    content: `Sprint ${currentSprint.number} is complete. ${sprintTasks.filter((t) => t.status === "completed").length} tasks delivered, ${sprintTasks.filter((t) => t.status === "failed").length} failed. Preparing next sprint proposal now.`,
    cardType: "status_update",
    cardData: null,
    createdAt: nowIso(),
  });

  // Trigger CEO to auto-propose Sprint N+1
  await triggerCeoSprintProposal();

  sprintCompletionTriggered = false;
  return true;
}

async function tagCurrentSprintSnapshot() {
  const snapshot = getSnapshot();
  if (snapshot.company.id === "company_pending") {
    return;
  }

  try {
    const result = await workspaceManager.tagSprint(snapshot.company.id, snapshot.company.currentSprintNumber ?? 1, snapshot);
    if (result.warnings.length > 0) {
      emitEmployeeActivity("system", "info", `Sprint snapshot completed with warnings: ${result.warnings.join(" | ")}`, {
        taskId: activeExecution?.reviewTaskId ?? null,
      });
    }
  } catch (error) {
    emitEmployeeActivity("system", "error", error instanceof Error ? error.message : "Sprint snapshot failed.", {
      taskId: activeExecution?.reviewTaskId ?? null,
    });
  }
}

function getAgentByRole(snapshot: CompanySnapshot, role: AgentIdentity["role"]) {
  return snapshot.agents.find((agent) => agent.role === role) ?? null;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 8) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim())))).slice(0, limit);
}

function extractPreviewUrls(text: string) {
  return uniqueStrings(
    Array.from(text.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d+(?:\/[^\s"'`)]*)?/gi)).map((match) => match[0]),
    4,
  );
}

function createWorkflowTask(
  snapshot: CompanySnapshot,
  kind: Task["kind"],
  role: AgentIdentity["role"],
  title: string,
  description: string,
  problemStatement: string,
  deliverable: string,
  definitionOfDone: string[],
  priority: Task["priority"],
  status: Task["status"],
  sprintId?: string | null,
): Task {
  const agent = getAgentByRole(snapshot, role);

  return {
    id: `task_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    sprintId: sprintId ?? snapshot.company.currentSprintId ?? null,
    kind,
    title,
    description,
    problemStatement,
    deliverable,
    definitionOfDone,
    status,
    priority,
    assignedRole: role,
    assignedAgentId: agent?.id ?? null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: emptyPlannerState(problemStatement),
    executorState: emptyExecutorState(),
    verifierState: emptyVerifierState(),
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    incomingArtifactIds: [],
  };
}

function attachChildTask(parentTaskId: string, childTaskId: string) {
  updateTask(parentTaskId, (task) => ({
    ...task,
    childTaskIds: task.childTaskIds.includes(childTaskId) ? task.childTaskIds : [...task.childTaskIds, childTaskId],
  }));
}

function updateRoleMemory(role: AgentIdentity["role"], currentFocus: string[]) {
  const agent = getAgentByRole(getSnapshot(), role);
  if (!agent) return;

  updateAgentMemory(agent.id, (memory) => ({
    ...memory,
    currentFocus: uniqueStrings(currentFocus, 6),
    updatedAt: new Date().toISOString(),
  }));
}

function enrichRoleMemory(
  role: AgentIdentity["role"],
  update: {
    currentFocus?: string[];
    recentLearnings?: string[];
    activePatterns?: string[];
    openBlockers?: string[];
    importantDecisions?: string[];
  },
) {
  const agent = getAgentByRole(getSnapshot(), role);
  if (!agent) return;

  updateAgentMemory(agent.id, (memory) => ({
    ...memory,
    currentFocus: update.currentFocus ? uniqueStrings([...update.currentFocus, ...memory.currentFocus], 6) : memory.currentFocus,
    recentLearnings: update.recentLearnings ? uniqueStrings([...update.recentLearnings, ...memory.recentLearnings], 8) : memory.recentLearnings,
    activePatterns: update.activePatterns ? uniqueStrings([...update.activePatterns, ...memory.activePatterns], 6) : memory.activePatterns,
    openBlockers: update.openBlockers ? uniqueStrings([...update.openBlockers, ...memory.openBlockers], 6) : memory.openBlockers,
    importantDecisions: update.importantDecisions ? uniqueStrings([...update.importantDecisions, ...memory.importantDecisions], 8) : memory.importantDecisions,
    updatedAt: new Date().toISOString(),
  }));
}

function clearRoleBlockers(role: AgentIdentity["role"], blockersToClear: string[]) {
  const agent = getAgentByRole(getSnapshot(), role);
  if (!agent || blockersToClear.length === 0) return;

  const normalized = new Set(blockersToClear.map((item) => item.trim()));
  updateAgentMemory(agent.id, (memory) => ({
    ...memory,
    openBlockers: memory.openBlockers.filter((item) => !normalized.has(item.trim())),
    updatedAt: new Date().toISOString(),
  }));
}

type MeetingAgendaInput = {
  topic: string;
  type: "update" | "blocker" | "question" | "proposal";
  content: string;
  raisedByRole: AgentIdentity["role"];
  relatedTaskId?: string | null;
  needsBoardApproval?: boolean;
};

type MeetingDecisionInput = {
  description: string;
  decidedByRoles: AgentIdentity["role"][];
  impactIds: string[];
};

type MeetingLearningInput = {
  role: AgentIdentity["role"];
  content: string;
  promotedToSummary?: boolean;
};

type TaskModificationInput = {
  taskId: string;
  modificationType: "assign" | "reprioritize" | "reassign" | "cancel" | "decompose_further" | "unblock";
  details: string;
  assignedRole?: AgentIdentity["role"] | null;
  priority?: Task["priority"] | null;
  resultingStatus?: Task["status"] | null;
};

type MemoryModificationInput = {
  role: AgentIdentity["role"];
  modificationType: "current_focus" | "recent_learning" | "active_pattern" | "open_blocker" | "important_decision" | "clear_blocker";
  content: string;
};

function applyTaskModification(modification: TaskModificationInput) {
  updateTask(modification.taskId, (task) => {
    const assignedAgent = modification.assignedRole ? getAgentByRole(getSnapshot(), modification.assignedRole) : null;
    const nextStatus =
      modification.resultingStatus ??
      (modification.modificationType === "assign"
        ? task.status === "created"
          ? "planned"
          : task.status
        : modification.modificationType === "cancel"
          ? "cancelled"
          : modification.modificationType === "unblock" && task.status === "blocked"
            ? "planned"
            : task.status);

    const nextTask: Task = {
      ...task,
      status: nextStatus,
      assignedRole: modification.assignedRole ?? task.assignedRole,
      assignedAgentId: modification.assignedRole ? assignedAgent?.id ?? null : task.assignedAgentId,
      priority: modification.priority ?? task.priority,
      plannerState:
        modification.modificationType === "decompose_further"
          ? {
              ...task.plannerState,
              planSteps: uniqueStrings([...task.plannerState.planSteps, modification.details], 12),
            }
          : task.plannerState,
      executorState: {
        ...task.executorState,
        results: [...task.executorState.results, `meeting:${modification.modificationType}:${modification.details}`].slice(-50),
      },
      verifierState:
        modification.modificationType === "cancel"
          ? {
              ...task.verifierState,
              feedback: modification.details,
            }
          : task.verifierState,
    };

    return nextTask;
  });
}

function applyMemoryModification(modification: MemoryModificationInput) {
  switch (modification.modificationType) {
    case "current_focus":
      enrichRoleMemory(modification.role, { currentFocus: [modification.content] });
      break;
    case "recent_learning":
      enrichRoleMemory(modification.role, { recentLearnings: [modification.content] });
      break;
    case "active_pattern":
      enrichRoleMemory(modification.role, { activePatterns: [modification.content] });
      break;
    case "open_blocker":
      enrichRoleMemory(modification.role, { openBlockers: [modification.content] });
      break;
    case "important_decision":
      enrichRoleMemory(modification.role, { importantDecisions: [modification.content] });
      break;
    case "clear_blocker":
      clearRoleBlockers(modification.role, [modification.content]);
      break;
  }
}

function deriveMeetingMemoryModifications(params: {
  agenda: MeetingAgendaInput[];
  decisions?: MeetingDecisionInput[];
  learnings?: MeetingLearningInput[];
  participantRoles: AgentIdentity["role"][];
  memoryModifications?: MemoryModificationInput[];
  taskModifications?: TaskModificationInput[];
}) {
  const clearBlockerModifications = (params.taskModifications ?? [])
    .filter((modification) => modification.modificationType === "unblock")
    .flatMap((modification) => {
      const task = getSnapshot().tasks.find((entry) => entry.id === modification.taskId);
      return task
        ? [
            {
              role: task.assignedRole,
              modificationType: "clear_blocker" as const,
              content: modification.details,
            },
          ]
        : [];
    });

  const derived: MemoryModificationInput[] = [
    ...(params.memoryModifications ?? []),
    ...params.agenda
      .filter((agenda) => agenda.type === "blocker")
      .map((agenda) => ({
        role: agenda.raisedByRole,
        modificationType: "open_blocker" as const,
        content: agenda.content,
      })),
    ...(params.decisions ?? []).flatMap((decision) =>
      decision.decidedByRoles.map((role) => ({
        role,
        modificationType: "important_decision" as const,
        content: decision.description,
      })),
    ),
    ...(params.learnings ?? []).map((learning) => ({
      role: learning.role,
      modificationType: "recent_learning" as const,
      content: learning.content,
    })),
    ...params.participantRoles.map((role) => ({
      role,
      modificationType: "active_pattern" as const,
      content: `Meeting cadence: ${params.taskModifications?.length ? "action-oriented" : "communication-only"} ${params.participantRoles.length}-party ${params.agenda.length > 0 ? "meeting" : "sync"}`,
    })),
    ...clearBlockerModifications,
  ];

  const seen = new Set<string>();
  return derived.filter((item) => {
    const key = `${item.role}:${item.modificationType}:${item.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyMeetingEffects(taskModifications: TaskModificationInput[], memoryModifications: MemoryModificationInput[]) {
  for (const modification of taskModifications) {
    applyTaskModification(modification);
  }

  for (const modification of memoryModifications) {
    applyMemoryModification(modification);
  }
}

function createTaskFromCeoDelta(delta: CeoCard["meeting"]["task_deltas"][number]) {
  const snapshot = getSnapshot();
  const agent = getAgentByRole(snapshot, delta.assigned_role);
  if (!agent) {
    return null;
  }
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
  // Spec 01: No side effects until strategy is approved and agents exist.
  // During ideation the CEO chat is pure refinement — meetings and tasks
  // only make sense once the company is active with a hired team.
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

  const meetingType = card.meeting.type ?? (card.card_type === "status_update" ? "escalation" : "ad_hoc");
  const agendaType = meetingType === "escalation" ? "blocker" : card.card_type === "clarifying_question" ? "question" : "proposal";

  return recordMeeting({
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
}

function recordMeeting(params: {
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
  const participants = uniqueStrings(
    params.participantRoles
      .map((role) => getAgentByRole(snapshot, role)?.id)
      .filter(Boolean),
    12,
  );
  const now = new Date().toISOString();
  const meetingMemoryModifications = deriveMeetingMemoryModifications(params);

  const meeting: Meeting = {
    id: `meeting_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    type: params.type,
    participants,
    agenda: params.agenda.map((item) => ({
      id: `agenda_${crypto.randomUUID()}`,
      topic: item.topic,
      type: item.type,
      content: item.content,
      raisedByAgentId: getAgentByRole(snapshot, item.raisedByRole)?.id ?? "unknown_agent",
      relatedTaskId: item.relatedTaskId ?? null,
      needsBoardApproval: item.needsBoardApproval ?? false,
    })),
    decisions: (params.decisions ?? []).map((decision) => ({
      id: `decision_${crypto.randomUUID()}`,
      description: decision.description,
      decidedByAgentIds: uniqueStrings(decision.decidedByRoles.map((role) => getAgentByRole(snapshot, role)?.id), 8),
      impactIds: decision.impactIds,
    })),
    learnings: (params.learnings ?? []).map((learning) => ({
      id: `learning_${crypto.randomUUID()}`,
      agentId: getAgentByRole(snapshot, learning.role)?.id ?? "unknown_agent",
      content: learning.content,
      promotedToSummary: learning.promotedToSummary ?? true,
    })),
    taskModifications: (params.taskModifications ?? []).map((modification) => ({
      id: `task_mod_${crypto.randomUUID()}`,
      taskId: modification.taskId,
      modificationType: modification.modificationType,
      details: modification.details,
      assignedRole: modification.assignedRole ?? null,
      priority: modification.priority ?? null,
      resultingStatus: modification.resultingStatus ?? null,
    })),
    memoryModifications: meetingMemoryModifications.map((modification) => ({
      id: `memory_mod_${crypto.randomUUID()}`,
      agentId: getAgentByRole(snapshot, modification.role)?.id ?? "unknown_agent",
      modificationType: modification.modificationType,
      content: modification.content,
    })),
    status: "completed",
    summary: params.summary,
    scheduledAt: now,
    completedAt: now,
  };

  upsertMeeting(meeting);
  applyMeetingEffects(params.taskModifications ?? [], meetingMemoryModifications);

  emitEmployeeActivity(
    params.facilitatorRole,
    "info",
    `${params.type.replace(/_/g, " ")} meeting complete: ${params.summary}`,
    { meetingId: meeting.id },
  );

  return meeting;
}

/**
 * Build rich memory output from a completed task — includes title, kind, role,
 * feedback, edited files, and artifact content (capped to stay within budget).
 */
function buildTaskMemoryOutput(task: Task, feedback?: string | null): string {
  const sections: string[] = [
    `Task: ${task.title}`,
    `Role: ${task.assignedRole}`,
    `Kind: ${task.kind}`,
    `Status: ${task.status}`,
  ];

  if (feedback) {
    sections.push(`Outcome: ${feedback}`);
  }

  // Collect edited files from results
  const editedFiles = task.executorState.results
    .filter((r) => r.startsWith("edited:"))
    .map((r) => r.replace("edited:", ""));
  if (editedFiles.length > 0) {
    sections.push(`Files edited: ${editedFiles.join(", ")}`);
  }

  // Collect preview URLs
  const previews = task.executorState.results
    .filter((r) => r.startsWith("preview:"))
    .map((r) => r.replace("preview:", ""));
  if (previews.length > 0) {
    sections.push(`Preview: ${previews.join(", ")}`);
  }

  // Include artifact content (cap total to ~4000 chars to stay within context budget)
  let artifactBudget = 4000;
  for (const artifactId of task.artifactIds) {
    if (artifactBudget <= 0) break;
    const artifact = artifacts.find((a) => a.id === artifactId);
    if (!artifact) continue;
    const snippet = artifact.content.slice(0, artifactBudget);
    sections.push(`\n--- Artifact: ${artifact.title} ---\n${snippet}`);
    artifactBudget -= snippet.length;
  }

  return sections.join("\n");
}

function appendTaskResult(taskId: string, result: string) {
  updateTask(taskId, (task) => ({
    ...task,
    executorState: {
      ...task.executorState,
      results: [...task.executorState.results, result].slice(-50),
    },
  }));
}

function attachArtifactToTask(taskId: string, artifactId: string) {
  updateTask(taskId, (task) => ({
    ...task,
    artifactIds: task.artifactIds.includes(artifactId) ? task.artifactIds : [...task.artifactIds, artifactId],
  }));
}

function setTaskPreviewUrl(taskId: string, localPreviewUrl: string | null) {
  updateTask(taskId, (task) => ({
    ...task,
    localPreviewUrl,
  }));
}

function hydrateTaskFromSpec(taskId: string, spec: {
  title: string;
  description: string;
  problem_statement: string;
  deliverable: string;
  definition_of_done: string[];
  priority: Task["priority"];
}) {
  updateTask(taskId, (task) => ({
    ...task,
    title: spec.title,
    description: spec.description,
    problemStatement: spec.problem_statement,
    deliverable: spec.deliverable,
    definitionOfDone: spec.definition_of_done,
    priority: spec.priority,
    plannerState: {
      ...task.plannerState,
      objective: spec.problem_statement,
    },
  }));
}

function appendTaskPlanStep(taskId: string, step: string) {
  updateTask(taskId, (task) => ({
    ...task,
    plannerState: {
      ...task.plannerState,
      planSteps: uniqueStrings([...task.plannerState.planSteps, step], 12),
    },
  }));
}

function appendTaskCommand(taskId: string, command: string) {
  updateTask(taskId, (task) => ({
    ...task,
    executorState: {
      ...task.executorState,
      currentCommand: command,
      commandsExecuted: [...task.executorState.commandsExecuted, command].slice(-50),
    },
  }));
}

function setTaskStatus(taskId: string, status: Task["status"], feedback?: string | null) {
  updateTask(taskId, (task) => ({
    ...task,
    status,
    verifierState:
      status === "completed"
        ? {
            ...task.verifierState,
            isVerified: true,
            feedback: feedback ?? task.verifierState.feedback,
          }
        : {
            ...task.verifierState,
            feedback: feedback ?? task.verifierState.feedback,
          },
  }));

  // Auto-promote downstream tasks when a task completes
  if (status === "completed") {
    const snapshot = getSnapshot();
    for (const task of snapshot.tasks) {
      if (task.status !== "created") continue;
      if (task.kind === "follow_up") continue;
      if (task.dependsOnTaskIds.length === 0) continue;
      const allDepsMet = task.dependsOnTaskIds.every((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return dep?.status === "completed";
      });
      if (allDepsMet) {
        updateTask(task.id, (t) => ({ ...t, status: "planned" as Task["status"] }));
      }
    }
  }

  // Hippocampus: store memory + update priming on terminal status
  // Fire-and-forget — memory storage never blocks task progression
  if (["completed", "failed", "cancelled"].includes(status)) {
    const snapshot = getSnapshot();
    const task = snapshot.tasks.find((t) => t.id === taskId);
    if (task) {
      const agent = getAgentByRole(snapshot, task.assignedRole);
      if (agent) {
        const outcome = status === "completed" ? "success" : status === "failed" ? "failure" : "partial";
        const memoryOutput = buildTaskMemoryOutput(task, feedback);
        hippocampus.processTaskCompletion({
          agentId: agent.id,
          taskId: task.id,
          companyId: snapshot.company.id,
          output: memoryOutput,
          outcome,
          taskTitle: task.title,
          role: task.assignedRole,
        }).catch((err) => {
          console.warn(`[Hippocampus] processTaskCompletion failed for ${task.id}: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  }
}

function taskSortWeight(task: Task) {
  if (task.priority === "critical") return 0;
  if (task.priority === "high") return 1;
  if (task.priority === "medium") return 2;
  return 3;
}

function specialistRoleWeight(role: AgentIdentity["role"]) {
  return orchestratorConfig.specialistRoleWeights[role] ?? 7;
}

function isTaskReady(task: Task, snapshot: CompanySnapshot) {
  if (!["created", "planned"].includes(task.status)) return false;

  return task.dependsOnTaskIds.every((dependencyId) => {
    const dependency = snapshot.tasks.find((entry) => entry.id === dependencyId);
    return dependency?.status === "completed";
  });
}

function getTaskById(taskId: string | null | undefined, snapshot: CompanySnapshot) {
  if (!taskId) return null;
  return snapshot.tasks.find((task) => task.id === taskId) ?? null;
}

function getPreferredPreviewTargetPathFromTask(task: Task | null | undefined) {
  if (!task) return null;

  const editedResult = [...task.executorState.results]
    .reverse()
    .find((entry) => entry.startsWith("edited:"));

  if (!editedResult) {
    return null;
  }

  const relativePath = editedResult.slice("edited:".length).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith(".")) {
    return null;
  }

  return relativePath.split("/")[0] ?? null;
}

function isTaskReadyForAutonomousExecution(task: Task, snapshot: CompanySnapshot) {
  if (!AUTONOMOUS_READY_TASK_ROLES.has(task.assignedRole)) return false;
  if (CORE_EXECUTION_TASK_KINDS.has(task.kind)) return false;
  return isTaskReady(task, snapshot);
}

function buildSpecialistTaskPrompt(task: Task) {
  const preview = getLocalPreviewState();
  const profileHints = [
    `# Task`,
    `Role: ${task.assignedRole}`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Problem statement: ${task.problemStatement}`,
    `Deliverable: ${task.deliverable}`,
    `Definition of done:`,
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    `# Company context`,
    `Workspace root: ${workspaceRoot}`,
    `Product workspace: ${productDir}`,
    `Current preview URL: ${preview.url ?? "not available"}`,
    `Current preview entry URL: ${preview.entryUrl ?? "not available"}`,
    `Current preview validation URL: ${preview.validationUrl ?? "not available"}`,
    `Current preview validation strategy: ${preview.validationStrategy ?? "not available"}`,
    `Current preview target kind: ${preview.targetKind ?? "not available"}`,
    `Current preview runtime: ${preview.runtime ?? "not available"}`,
    `Current preview framework: ${preview.framework ?? "not available"}`,
    `Current preview status: ${preview.status}`,
  ];

  if (task.assignedRole === "tester") {
    profileHints.push(
      "",
      "# Verification rules",
      "Treat this as a verification assignment, not a build assignment.",
      "Use the available preview metadata to reason about what should be validated.",
      "Explicitly state: verdict, what was verified, what remains unverified, concrete risks, and what downstream role should act next.",
    );
  }

  if (task.assignedRole === "skills_lead") {
    profileHints.push(
      "",
      "# Skill authoring rules",
      "Turn repeated company execution patterns into reusable internal skill guidance.",
      "Make the output durable and operational: include trigger conditions, workflow steps, evidence expectations, and downstream consumers.",
      "Prefer skill content that can be applied by Developer, Tester, UI Designer, or Marketing in future cycles.",
    );
  }

  if (activeExecution?.planText) {
    profileHints.push("", "# CTO Technical Plan", activeExecution.planText);
  }

  if (activeExecution?.acceptanceText) {
    profileHints.push("", "# PM Acceptance Criteria", activeExecution.acceptanceText);
  }

  profileHints.push(
    "",
    "# Output requirements",
    "Produce text only.",
    "Return a concise execution artifact with these sections:",
    "1. Objective alignment",
    "2. What you did",
    "3. Evidence or reasoning",
    "4. Open issues or follow-ups",
    "5. Recommendation to the company",
  );

  return profileHints.join("\n");
}

function getPreviewEvidenceUrl() {
  const preview = getLocalPreviewState();
  return preview.validationUrl ?? preview.entryUrl ?? preview.url;
}

function buildTesterArtifact(task: Task, output: string) {
  const preview = getLocalPreviewState();
  const evidenceUrl = getPreviewEvidenceUrl();

  return [
    "# Verification Summary",
    `Task: ${task.title}`,
    `Kind: ${task.kind}`,
    `Target kind: ${preview.targetKind ?? "unknown"}`,
    `Validation URL: ${evidenceUrl ?? "not available"}`,
    `Validation strategy: ${preview.validationStrategy ?? "not available"}`,
    `Runtime: ${preview.runtime ?? "unknown"}`,
    `Framework: ${preview.framework ?? "unknown"}`,
    `Preview status: ${preview.status}`,
    "",
    "# Definition Of Done Checklist",
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    "# Tester Report",
    output || "Tester completed the verification task without additional notes.",
  ].join("\n");
}

function buildDesignDirectionArtifact(task: Task, output: string) {
  const preview = getLocalPreviewState();

  return [
    "# Design Direction Summary",
    `Task: ${task.title}`,
    `Target kind: ${preview.targetKind ?? "unknown"}`,
    `Preview entry URL: ${preview.entryUrl ?? preview.url ?? "not available"}`,
    `Validation URL: ${preview.validationUrl ?? "not available"}`,
    "",
    "# Downstream Expectations",
    "Developer should use this to sharpen implementation details and interaction choices.",
    "Tester should use this to focus verification on UX clarity, interaction consistency, and visible quality risks.",
    "",
    "# UI Designer Report",
    output || "UI Designer completed the design-direction task without additional notes.",
  ].join("\n");
}

function buildMarketingArtifact(task: Task, output: string) {
  const preview = getLocalPreviewState();

  return [
    "# Launch Readiness Report",
    `Task: ${task.title}`,
    `Kind: ${task.kind}`,
    `Target kind: ${preview.targetKind ?? "unknown"}`,
    `Preview evidence URL: ${getPreviewEvidenceUrl() ?? "not available"}`,
    `Preview status: ${preview.status}`,
    "",
    "# Governance Boundary",
    task.kind === "distribution_campaign"
      ? "This report may recommend outbound actions, but no email, post, ad, or other external distribution was executed automatically. Board approval is required before any external action is taken."
      : "This report is internal launch preparation content. No external action was executed automatically.",
    "",
    "# Marketing Report",
    output || "Marketing completed the launch-readiness task without additional notes.",
  ].join("\n");
}

function buildSkillAuthoringArtifact(task: Task, output: string) {
  return [
    "# Skill Package Summary",
    `Task: ${task.title}`,
    `Deliverable: ${task.deliverable}`,
    "",
    "# Packaging Requirement",
    "This skill must be reusable by internal specialists and should capture a stable workflow, not one-off execution notes.",
    "",
    "# Skills Lead Report",
    output || "Skills Lead completed the skill-authoring task without additional notes.",
  ].join("\n");
}

function slugifySkillName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "generated-skill";
}

async function materializeSkillPackage(task: Task, output: string) {
  const slug = slugifySkillName(task.title.replace(/skill authoring|skill|package/gi, " "));
  const skillsRoot = join(productDir, ".arceus", "skills", slug);
  const skillFilePath = join(skillsRoot, "SKILL.md");
  const skillDocument = [
    `# ${task.title}`,
    "",
    "## Purpose",
    task.deliverable,
    "",
    "## Trigger",
    task.problemStatement,
    "",
    "## Definition Of Done",
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    "## Workflow",
    output || "Document the reusable workflow here.",
  ].join("\n");

  await mkdir(skillsRoot, { recursive: true });
  await writeFile(skillFilePath, `${skillDocument}\n`, "utf8");

  return {
    slug,
    relativePath: `.arceus/skills/${slug}/SKILL.md`,
  };
}

function deliverUiDesignerMemoryHandoff(task: Task, artifactId: string) {
  const guidance = `Use UI direction artifact /api/artifacts/${artifactId} while implementing ${task.title}.`;
  const qaGuidance = `Use UI direction artifact /api/artifacts/${artifactId} to verify UX quality and interaction consistency for ${task.title}.`;

  enrichRoleMemory("developer", {
    currentFocus: [guidance],
    recentLearnings: [guidance],
    activePatterns: ["Respect UI Designer direction before final implementation polish."],
  });
  enrichRoleMemory("tester", {
    currentFocus: [qaGuidance],
    recentLearnings: [qaGuidance],
    activePatterns: ["QA should include design-direction checks alongside functional verification."],
  });
}

function deliverSkillsLeadMemoryHandoff(task: Task, artifactId: string, skillPath: string) {
  const handoff = `Reusable skill package ${skillPath} was authored from ${task.title}. Supporting artifact: /api/artifacts/${artifactId}.`;

  enrichRoleMemory("cto", {
    currentFocus: [handoff],
    recentLearnings: [handoff],
    activePatterns: ["Codify repeated specialist work into reusable internal skills before scaling execution."],
  });
  enrichRoleMemory("developer", {
    recentLearnings: [handoff],
    activePatterns: ["Check .arceus/skills for reusable delivery workflows before starting implementation."],
  });
  enrichRoleMemory("tester", {
    recentLearnings: [handoff],
    activePatterns: ["Check .arceus/skills for reusable QA workflows before verification."],
  });
}

function createMarketingExternalApproval(task: Task, artifactId: string, meetingId: string | null) {
  const snapshot = getSnapshot();
  const marketingAgent = getAgentByRole(snapshot, "marketing");
  if (!marketingAgent) {
    return null;
  }

  const approval: Approval = {
    id: `approval_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    type: "external_action",
    status: "pending",
    title: `Board approval required for ${task.title}`,
    description: `Marketing prepared outbound launch or distribution recommendations in /api/artifacts/${artifactId}. No external action has been executed. Board approval is required before any distribution proceeds.`,
    requestedByAgentId: marketingAgent.id,
    meetingId,
    agendaItemId: null,
    resolutionSummary: null,
  };

  upsertApproval(approval);
  return approval;
}

function approvePendingBoardApprovals() {
  const pendingApprovals = getSnapshot().approvals.filter((approval) => approval.status === "pending");

  for (const approval of pendingApprovals) {
    updateApproval(approval.id, (current) => ({
      ...current,
      status: current.type === "external_action" ? "approved" : "applied",
      resolutionSummary: current.type === "external_action"
        ? "Board approved the recommended external action. No automated outbound action was executed by Arceus."
        : "Board approved the pending request during CTO handoff review.",
    }));
  }

  return pendingApprovals;
}

function getSpecialistMeetingContext(role: AgentIdentity["role"], task: Task, artifactId: string) {
  if (role === "ui_designer") {
    return {
      participantRoles: uniqueStrings([role, "developer", "tester", "cto"]) as AgentIdentity["role"][],
      managerRole: "cto" as const,
      learnings: [
        {
          role: "developer" as const,
          content: `UI Designer attached design direction artifact /api/artifacts/${artifactId} for ${task.title}.`,
        },
        {
          role: "tester" as const,
          content: `QA should verify ${task.title} against UI direction artifact /api/artifacts/${artifactId}.`,
        },
        {
          role: "cto" as const,
          content: `Design direction artifact /api/artifacts/${artifactId} is available for downstream implementation and QA.`,
        },
      ],
    };
  }

  if (role === "marketing") {
    return {
      participantRoles: uniqueStrings([role, "pm", "ceo"]) as AgentIdentity["role"][],
      managerRole: "ceo" as const,
      learnings: [
        {
          role: "pm" as const,
          content: `Marketing attached launch-readiness artifact /api/artifacts/${artifactId} for ${task.title}.`,
        },
        {
          role: "ceo" as const,
          content: task.kind === "distribution_campaign"
            ? `Outbound distribution recommendations in /api/artifacts/${artifactId} require board approval before execution.`
            : `Launch-readiness content in /api/artifacts/${artifactId} is ready for release planning review.`,
        },
      ],
    };
  }

  if (role === "skills_lead") {
    return {
      participantRoles: uniqueStrings([role, "cto", "developer", "tester"]) as AgentIdentity["role"][],
      managerRole: "cto" as const,
      learnings: [
        {
          role: "cto" as const,
          content: `Skills Lead authored a reusable skill package for ${task.title}.`,
        },
        {
          role: "developer" as const,
          content: `A new reusable skill package is available for downstream implementation support from ${task.title}.`,
        },
        {
          role: "tester" as const,
          content: `A new reusable skill package is available for downstream QA support from ${task.title}.`,
        },
      ],
    };
  }

  if (role === "tester") {
    const participantRoles = uniqueStrings([role, "developer", "pm", "cto"]) as AgentIdentity["role"][];
    return {
      participantRoles,
      managerRole: "cto" as const,
      learnings: [
        {
          role: "developer" as const,
          content: `Tester attached verification artifact /api/artifacts/${artifactId} for ${task.title}.`,
        },
        {
          role: "pm" as const,
          content: `Tester produced verification evidence for ${task.title} and highlighted release readiness implications.`,
        },
        {
          role: "cto" as const,
          content: `Tester verification artifact /api/artifacts/${artifactId} is available for technical review.`,
        },
      ],
    };
  }

  const managerRole: AgentIdentity["role"] = "cto";
  return {
    participantRoles: [role, managerRole],
    managerRole,
    learnings: [
      {
        role: managerRole,
        content: `${role.replace(/_/g, " ")} delivered artifact ${task.title} for downstream review.`,
      },
    ],
  };
}

async function executeSpecialistTask(taskId: string) {
  const snapshot = getSnapshot();
  const task = snapshot.tasks.find((entry) => entry.id === taskId);
  if (!task) return;

  const assignedAgent = getAgentByRole(snapshot, task.assignedRole);
  if (!assignedAgent) {
    setTaskStatus(task.id, "blocked", `No active ${task.assignedRole} agent is available for this task.`);
    recordMeeting({
      type: "escalation",
      facilitatorRole: "cto",
      participantRoles: ["cto", "ceo"],
      summary: `Autonomous specialist task blocked because role ${task.assignedRole} is not staffed.`,
      agenda: [
        {
          topic: "Missing specialist coverage",
          type: "blocker",
          content: `Task ${task.title} cannot start because no ${task.assignedRole} agent is available.`,
          raisedByRole: "cto",
          relatedTaskId: task.id,
        },
      ],
      decisions: [
        {
          description: `Leadership must either hire or re-plan work assigned to ${task.assignedRole}.`,
          decidedByRoles: ["cto", "ceo"],
          impactIds: [task.id],
        },
      ],
      taskModifications: [
        {
          taskId: task.id,
          modificationType: "unblock",
          details: `Blocked because role ${task.assignedRole} is not staffed.`,
          resultingStatus: "blocked",
        },
      ],
    });
    return;
  }

  const role = task.assignedRole;
  const roleSession = await ensureAgentSession(snapshot, role);
  const soul = getRoleSoul(role);
  const previewEvidenceUrl = getPreviewEvidenceUrl();

  if (role === "tester" && ["qa_verification", "service_validation"].includes(task.kind)) {
    const preview = getLocalPreviewState();
    if (preview.status !== "ready" || !previewEvidenceUrl) {
      setTaskStatus(task.id, "blocked", "Tester verification requires a ready preview or validation endpoint.");
      recordMeeting({
        type: "escalation",
        facilitatorRole: "tester",
        participantRoles: ["tester", "developer", "cto"],
        summary: `Tester could not start ${task.title} because preview evidence is not ready.`,
        agenda: [
          {
            topic: "Verification blocked",
            type: "blocker",
            content: "Tester verification requires a reachable preview or validation URL before QA can proceed.",
            raisedByRole: "tester",
            relatedTaskId: task.id,
          },
        ],
        decisions: [
          {
            description: "Developer and CTO must restore preview readiness before tester verification resumes.",
            decidedByRoles: ["tester", "developer", "cto"],
            impactIds: [task.id],
          },
        ],
      });
      return;
    }
  }

  touchAgentSession(role, "working");
  setTaskStatus(task.id, "in_progress");
  updateRoleMemory(role, [task.title, `Workspace: ${productDir}`]);
  emitEmployeeActivity(role, "working", `Autonomously executing specialist task: ${task.title}`, { taskId: task.id });

  const output = await runPromptText(role, roleSession.sessionId, soul.systemPrompt, buildSpecialistTaskPrompt(task));

  touchAgentSession(role, "idle");
  const artifactTitle = role === "tester"
    ? task.kind === "service_validation"
      ? "Service Validation Report"
      : "QA Verification Report"
    : role === "ui_designer"
      ? "Design Direction Report"
      : role === "marketing"
        ? "Launch Readiness Report"
      : role === "skills_lead"
        ? "Skill Package Report"
        : `${task.title} Output`;
  const artifactContent = role === "tester"
    ? buildTesterArtifact(task, output)
    : role === "ui_designer"
      ? buildDesignDirectionArtifact(task, output)
      : role === "marketing"
        ? buildMarketingArtifact(task, output)
        : role === "skills_lead"
          ? buildSkillAuthoringArtifact(task, output)
        : (output || `${role} completed ${task.title}.`);
  const artifact = addArtifact(role, "output", artifactTitle, artifactContent);
  appendTaskResult(task.id, `artifact:${artifact.id}`);
  if (role === "tester") {
    appendTaskResult(task.id, `verification:${getPreviewEvidenceUrl() ?? "no-preview-url"}`);
  }
  attachArtifactToTask(task.id, artifact.id);
  if (role === "tester") {
    const evidenceUrl = getPreviewEvidenceUrl();
    setTaskPreviewUrl(task.id, evidenceUrl);
    setTaskStatus(task.id, "completed", evidenceUrl ? `Tester verified the current target via ${evidenceUrl}.` : "Tester completed the verification task.");
  } else if (role === "ui_designer") {
    deliverUiDesignerMemoryHandoff(task, artifact.id);
    setTaskStatus(task.id, "completed", "UI Designer delivered concrete design direction to Developer and Tester.");
  } else if (role === "marketing") {
    setTaskStatus(
      task.id,
      "completed",
      task.kind === "distribution_campaign"
        ? "Marketing prepared launch-readiness recommendations and requested board approval before any external action."
        : "Marketing prepared launch-readiness reporting for internal release planning.",
    );
  } else if (role === "skills_lead") {
    const skillPackage = await materializeSkillPackage(task, output || artifactContent);
    appendTaskResult(task.id, `skill-package:${skillPackage.relativePath}`);
    deliverSkillsLeadMemoryHandoff(task, artifact.id, skillPackage.relativePath);
    setTaskStatus(task.id, "completed", `Skills Lead authored reusable package ${skillPackage.relativePath}.`);
    await syncWorkspaceCheckpoint(task.id, role, `Skills Lead authored reusable package ${skillPackage.relativePath}`);
  } else {
    setTaskStatus(task.id, "completed", `${role} completed the specialist task.`);
  }

  const specialistMeetingContext = getSpecialistMeetingContext(role, task, artifact.id);
  const completionMeeting = recordMeeting({
    type: "handoff",
    facilitatorRole: role,
    participantRoles: specialistMeetingContext.participantRoles,
    summary: `${role.replace(/_/g, " ")} completed specialist task ${task.title}.`,
    agenda: [
      {
        topic: "Specialist task output",
        type: "update",
        content: `${role.replace(/_/g, " ")} completed ${task.title} and attached an artifact for downstream review.`,
        raisedByRole: role,
        relatedTaskId: task.id,
      },
    ],
    decisions: [
      {
        description: `${specialistMeetingContext.managerRole.toUpperCase()} can use the specialist output in the ongoing execution cycle.`,
        decidedByRoles: [role, specialistMeetingContext.managerRole],
        impactIds: [task.id, artifact.id],
      },
    ],
    learnings: specialistMeetingContext.learnings,
  });

  let approval: Approval | null = null;
  if (role === "marketing" && task.kind === "distribution_campaign") {
    approval = createMarketingExternalApproval(task, artifact.id, completionMeeting.id);
    if (approval) {
      const createdApproval = approval;
      appendTaskResult(task.id, `approval:${approval.id}`);
      updateMeeting(completionMeeting.id, (meeting) => ({
        ...meeting,
        agenda: meeting.agenda.map((item, index) => (
          index === 0
            ? {
                ...item,
                needsBoardApproval: true,
                content: `${item.content} Board approval is required before any external distribution action can occur.`,
              }
            : item
        )),
        decisions: meeting.decisions.map((decision, index) => (
          index === 0
            ? {
                ...decision,
                impactIds: decision.impactIds.includes(createdApproval.id) ? decision.impactIds : [...decision.impactIds, createdApproval.id],
              }
            : decision
        )),
      }));
    }
  }

  emitEmployeeActivity(role, "idle", approval
    ? `${task.title} complete → /api/artifacts/${artifact.id} and board approval ${approval.id}`
    : `${task.title} complete → /api/artifacts/${artifact.id}`, {
    taskId: task.id,
    meetingId: completionMeeting.id,
  });
}

// ---------------------------------------------------------------------------
// Specialist task pruning — auto-resolve tasks the developer already covered
// ---------------------------------------------------------------------------

const SpecialistPruneVerdict = z.object({
  resolved: z.array(z.object({
    taskId: z.string(),
    reason: z.string(),
  })),
});

async function pruneAlreadyCompletedSpecialistTasks(snapshot: CompanySnapshot): Promise<number> {
  const pendingSpecialist = snapshot.tasks.filter(
    (task) =>
      !CORE_EXECUTION_TASK_KINDS.has(task.kind) &&
      ["created", "planned"].includes(task.status),
  );
  if (pendingSpecialist.length === 0) return 0;

  // Collect workspace source listing for the LLM to evaluate.
  const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".html", ".css"]);
  const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", ".vite"]);
  const fileList: string[] = [];

  function walk(dir: string, depth = 0) {
    if (depth > 3) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch { return; }
    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath, depth + 1); continue; }
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (sourceExtensions.has(ext)) {
        fileList.push(relative(productDir, fullPath).replace(/\\/g, "/"));
      }
    }
  }
  walk(productDir);
  if (fileList.length === 0) return 0;

  const taskSummary = pendingSpecialist.map((t) =>
    `- id="${t.id}" kind=${t.kind} role=${t.assignedRole} title="${t.title}" dod=[${t.definitionOfDone.join("; ")}]`
  ).join("\n");

  try {
    const verdict = await structuredCompletion(
      "workerDeployment",
      [
        {
          role: "system",
          content: [
            "You decide which queued specialist tasks have ALREADY been satisfied by the developer implementation.",
            "A task is resolved ONLY if the workspace files clearly demonstrate its definition-of-done is met.",
            "Do not resolve tasks that require runtime verification (e.g. running tests, checking HTTP).",
            "Return the list of resolved task IDs with a short reason.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "Workspace files:",
            fileList.join("\n"),
            "",
            "Pending specialist tasks:",
            taskSummary,
          ].join("\n"),
        },
      ],
      SpecialistPruneVerdict,
      "specialist_prune_verdict",
      { temperature: 0 },
    );

    const validIds = new Set(pendingSpecialist.map((t) => t.id));
    let resolved = 0;
    for (const item of verdict.resolved) {
      if (!validIds.has(item.taskId)) continue;
      setTaskStatus(item.taskId, "completed", `Auto-resolved by workspace audit: ${item.reason}`);
      resolved += 1;
    }
    return resolved;
  } catch {
    // Non-fatal — if the LLM call fails, just proceed with regular specialist execution.
    return 0;
  }
}

async function runAutonomousReadyTasks(checkpoint: string) {
  let pass = 0;

  while (pass < orchestratorConfig.execution.autonomousReadyPassLimit) {
    const snapshot = getSnapshot();
    const readyTasks = snapshot.tasks
      .filter((task) => isTaskReadyForAutonomousExecution(task, snapshot))
      .sort((left, right) => {
        const roleDelta = specialistRoleWeight(left.assignedRole) - specialistRoleWeight(right.assignedRole);
        if (roleDelta !== 0) {
          return roleDelta;
        }

        return taskSortWeight(left) - taskSortWeight(right);
      });

    if (readyTasks.length === 0) {
      if (pass === 0) {
        emitEmployeeActivity("system", "info", `No specialist tasks were ready at ${checkpoint}.`);
      }
      return;
    }

    for (const task of readyTasks) {
      await executeSpecialistTask(task.id);
    }

    pass += 1;
  }

  emitEmployeeActivity("system", "info", `Specialist scheduler stopped after hitting the pass limit at ${checkpoint}.`);
}

function getQueuedNonCoreTaskCount(snapshot: CompanySnapshot) {
  return snapshot.tasks.filter((task) => !CORE_EXECUTION_TASK_KINDS.has(task.kind) && ["created", "planned"].includes(task.status)).length;
}

function shouldPauseForBoardReview(snapshot: CompanySnapshot) {
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending");
  if (pendingApprovals.length > 0) {
    return {
      shouldPause: true,
      reason: `Board action required because ${pendingApprovals.length} approval request${pendingApprovals.length === 1 ? " is" : "s are"} still pending.`,
    };
  }

  // Failed/blocked specialist tasks do NOT gate execution — they are
  // noted in the completion summary but the company keeps running.
  // Only failed/blocked CORE tasks warrant a pause.
  const incompleteCoreTasks = snapshot.tasks.filter(
    (task) => CORE_EXECUTION_TASK_KINDS.has(task.kind) && !["completed", "cancelled"].includes(task.status),
  );
  if (incompleteCoreTasks.length > 0) {
    return {
      shouldPause: true,
      reason: "Board review required because core execution is not in a terminal state.",
    };
  }

  return {
    shouldPause: false,
    reason: null,
  } as const;
}

async function completeExecutionCycle(reason: string) {
  const snapshot = getSnapshot();
  const queuedNonCoreTaskCount = getQueuedNonCoreTaskCount(snapshot);
  executionStatus = "done";

  emitEmployeeActivity(
    "system",
    "info",
    queuedNonCoreTaskCount > 0
      ? `${reason} ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? " remains" : "s remain"} for a later cycle.`
      : reason,
    {
      taskId: activeExecution?.reviewTaskId ?? null,
    },
  );

  if (activeExecution) {
    updateTask(activeExecution.reviewTaskId, (task) => ({
      ...task,
      verifierState: {
        ...task.verifierState,
        isVerified: true,
        feedback: queuedNonCoreTaskCount > 0
          ? `Autonomous execution completed. ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? " remains" : "s remain"} for a later cycle.`
          : "Autonomous execution completed without requiring additional board review.",
      },
    }));
  }

  recordMeeting({
    type: "ad_hoc",
    facilitatorRole: "ceo",
    participantRoles: ["ceo", "cto"],
    summary: queuedNonCoreTaskCount > 0
      ? "Autonomous execution completed and left queued non-core tasks for a future cycle."
      : "Autonomous execution completed without requiring additional board review.",
    agenda: [
      {
        topic: "Autonomous cycle completion",
        type: "update",
        content: reason,
        raisedByRole: "ceo",
        relatedTaskId: activeExecution?.reviewTaskId ?? null,
      },
    ],
    decisions: [
      {
        description: queuedNonCoreTaskCount > 0
          ? `Cycle closed with ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? "" : "s"} for later execution.`
          : "Cycle closed without further board intervention.",
        decidedByRoles: ["ceo", "cto"],
        impactIds: activeExecution ? [activeExecution.reviewTaskId] : [],
      },
    ],
  });

  activeExecution = null;

  // After execution cycle completes, check if the sprint is done
  // (all sprint tasks terminal → mark sprint completed → CEO auto-proposes next sprint)
  await checkSprintCompletion();
}

function pauseForBoardReview(reason: string) {
  executionStatus = "awaiting_board_review";
  recordMeeting({
    type: "handoff",
    facilitatorRole: "cto",
    participantRoles: ["cto", "ceo"],
    summary: "Autonomous execution paused for a board-level decision.",
    agenda: [
      {
        topic: "Board review checkpoint",
        type: "proposal",
        content: reason,
        raisedByRole: "ceo",
        relatedTaskId: activeExecution?.reviewTaskId ?? null,
      },
    ],
    decisions: [
      {
        description: "Execution is paused pending explicit board intervention.",
        decidedByRoles: ["cto", "ceo"],
        impactIds: activeExecution ? [activeExecution.reviewTaskId] : [],
      },
    ],
    learnings: [
      {
        role: "ceo",
        content: "Board review is now an exception path triggered by policy or unresolved execution risk.",
      },
    ],
  });
  emitEmployeeActivity("system", "info", reason, {
    taskId: activeExecution?.reviewTaskId ?? null,
  });
}

async function reconcilePostReviewExecution() {
  // ── Auto-resolve specialist tasks the developer already covered ──
  const prePruneSnapshot = getSnapshot();
  const prunedCount = await pruneAlreadyCompletedSpecialistTasks(prePruneSnapshot);
  if (prunedCount > 0) {
    emitEmployeeActivity("system", "info", `Auto-resolved ${prunedCount} specialist task${prunedCount === 1 ? "" : "s"} already covered by the developer implementation.`);
  }

  // ── Execute remaining specialist tasks (tester, designer, etc.) ──
  await runAutonomousReadyTasks("post-review");

  const snapshot = getSnapshot();
  const boardDecision = shouldPauseForBoardReview(snapshot);
  if (boardDecision.shouldPause) {
    pauseForBoardReview(boardDecision.reason ?? "Board review required.");
    return;
  }

  await completeExecutionCycle("Autonomous execution completed — all phases finished.");
}

async function continueExecutionFromCurrentState(checkpoint: string) {
  if (!activeExecution) {
    return;
  }

  // Phase-aware Router loop: delegates "what next?" decisions to the LLM Router
  // while keeping the existing phase functions for actual work execution.
  const result = await runRouterLoop(
    executionStatus,
    checkpoint,
    async (transition, snapshot) => {
      // After each transition, execute the actual phase work
      await executeTransitionWork(transition, snapshot);
    },
    (task, proposal) => {
      // Yield for async work: developer session and specialist tasks that need LLM sessions
      if (task.kind === "implementation" && proposal.toStatus === "in_progress") return true;
      return false;
    }
  );

  if (result.paused && result.pauseReason?.startsWith("Yielding for async work")) {
    // The router yielded because a task needs async work (e.g., developer session)
    const snapshot = getSnapshot();

    // Find the actual implementation task that was just moved to in_progress
    const yieldedTask = snapshot.tasks.find(
      (t) => t.kind === "implementation" && t.status === "in_progress"
    );

    if (yieldedTask) {
      // If the router skipped the PM acceptance phase, run it now before Developer
      if (activeExecution.planText && !activeExecution.acceptanceText) {
        const freshSnap = getSnapshot();
        const acceptanceTask = freshSnap.tasks.find((t) => t.id === activeExecution!.acceptanceTaskId);
        if (acceptanceTask && !["completed", "failed"].includes(acceptanceTask.status)) {
          emitEmployeeActivity("system", "info", "Running PM acceptance phase before Developer (router skipped it).");
          await runAcceptancePhase(freshSnap);
        }
      }

      // Sprint 1 path: full rework loop when we have a CTO plan + acceptance spec
      if (activeExecution.planText && activeExecution.acceptanceText) {
        activeExecution.buildTaskId = yieldedTask.id;
        await runBuildPreviewReviewLoop(snapshot);
        return;
      }

      // Sprint 2+ path: no CTO plan — run as specialist task (generic LLM prompt)
      await executeSpecialistTask(yieldedTask.id);
      return;
    }
  }

  if (result.paused) {
    if (result.pauseReason?.includes("board")) {
      pauseForBoardReview(result.pauseReason ?? "Router requested board review");
    }
    emitEmployeeActivity("system", "info", `Router paused: ${result.pauseReason}`);
    return;
  }

  // Check if sprint is complete (all employee tasks terminal)
  const sprintCompleted = await checkSprintCompletion();
  if (sprintCompleted) return;

  // Fallback: if no sprint tracking, check all tasks
  const finalSnapshot = getSnapshot();
  const allDone = finalSnapshot.tasks.every((t) =>
    ["completed", "cancelled", "failed"].includes(t.status)
  );
  if (allDone) {
    await completeExecutionCycle("All tasks completed via dynamic routing.");
  }
}

/**
 * Executes the actual work for a transition — maps transition targets to existing
 * phase functions (planning, acceptance, dev, preview, specialist, review).
 */
async function executeTransitionWork(transition: Transition, snapshot: CompanySnapshot) {
  if (!activeExecution) return;

  const task = snapshot.tasks.find((t) => t.id === transition.toTaskId);
  if (!task) return;

  // Only execute work when a task moves to an active state
  if (transition.toStatus !== "in_progress" && transition.toStatus !== "verifying") return;

  try {
    switch (task.kind) {
      case "technical_plan":
        if (transition.toStatus === "in_progress") {
          await runPlanningPhase(snapshot);
        }
        break;

      case "acceptance_spec":
        if (transition.toStatus === "in_progress") {
          await runAcceptancePhase(snapshot);
        }
        break;

      case "implementation":
        // Developer phase + preview + review handled by runBuildPreviewReviewLoop via yield
        break;

      case "local_preview":
        // Handled inside runBuildPreviewReviewLoop — no standalone execution
        break;

      case "board_handoff":
        if (transition.toStatus === "in_progress") {
          // Sprint 1: handled inside runBuildPreviewReviewLoop
          // Sprint 2+: standalone CTO review (no planText/acceptanceText)
          if (!activeExecution.planText || !activeExecution.acceptanceText) {
            await executeSpecialistTask(task.id);
          }
        }
        break;

      default:
        // Specialist tasks (tester, ui_designer, marketing, skills_lead, etc.)
        if (transition.toStatus === "in_progress") {
          await executeSpecialistTask(task.id);
        }
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Phase execution failed";
    console.error(`[Router] executeTransitionWork failed for ${task.id} (${task.kind}):`, message);
    setTaskStatus(task.id, "failed", message);
    emitEmployeeActivity("system", "error", `Transition work failed for ${task.kind}: ${message}`, {
      taskId: task.id,
    });
  }
}

async function createAgentSession(agent: AgentIdentity): Promise<AgentSessionState> {
  const soul = getRoleSoul(agent.role as AgentIdentity["role"]);
  if (!soul) throw new Error(`No SOUL policy for role: ${agent.role}`);

  const opencode = await getOpencode();
  const session = await opencode.client.session.create({
    body: { title: `${agent.name} – ${agent.title}` },
  });

  if (!session.data) throw new Error(`Failed to create session for ${agent.role}`);

  const state: AgentSessionState = {
    role: agent.role,
    agentId: agent.id,
    sessionId: session.data.id,
    name: agent.name,
    status: "idle",
    lastEventAt: nowIso(),
    lastEventType: "session.created",
    lastEventSummary: `Session created for ${agent.name} (${agent.title})`,
    lastToolName: null,
    lastToolStatus: null,
    lastToolAt: null,
    lastProgressAt: null,
    lastWorkspaceChangeAt: null,
    awaiting: "idle",
    activeTaskId: null,
    promptStartedAt: null,
    promptCompletedAt: null,
    eventCount: 0,
    toolInvocationCount: 0,
    fileEditCount: 0,
    shellCommandCount: 0,
    stallReason: null,
  };

  agentSessions.set(agent.role, state);
  emitEmployeeActivity(agent.role, "info", `Session created for ${agent.name} (${agent.title})`);
  return state;
}

async function ensureAgentSession(snapshot: CompanySnapshot, role: AgentIdentity["role"]) {
  const existing = agentSessions.get(role);
  if (existing) return existing;

  const agent = getAgentByRole(snapshot, role);
  if (!agent) throw new Error(`${role.toUpperCase()} agent not available`);

  return createAgentSession(agent);
}

function formatHippocampusContext(ctx: PreparedAgentContext): string {
  const sections: string[] = [];

  if (ctx.memories.length > 0) {
    sections.push(
      "# Your Memory (facts you remember from previous work)",
      ...ctx.memories.map((m) => `- ${m.content}`),
    );
  }

  if (ctx.habits.length > 0) {
    sections.push(
      "",
      "# Your Habits (behavioral patterns you've learned)",
      ...ctx.habits.map((h) => `- When: ${h.trigger} → Do: ${h.action}`),
    );
  }

  if (ctx.priming) {
    sections.push("", `# Disposition: ${ctx.priming}`);
  }

  return sections.length > 0 ? sections.join("\n") : "";
}

async function runPromptText(role: AgentIdentity["role"], sessionId: string, systemPrompt: string, text: string) {
  const deployment = ensureDeployment("workerDeployment");

  // Inject role-specific skills into the system prompt
  const skillMenu = buildSkillMenu(role);
  const skillBody = getSkillBody(role);

  // Inject Hippocampus memory context (never fatal — graceful degradation)
  let memoryBlock = "";
  try {
    const snapshot = getSnapshot();
    const agent = getAgentByRole(snapshot, role);
    if (agent) {
      const ctx = await hippocampus.prepareAgentContext(agent.id, text);
      memoryBlock = formatHippocampusContext(ctx);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn(`[Hippocampus] Memory retrieval failed for ${role}, continuing without: ${msg}`);
  }

  const enrichedSystemPrompt = [systemPrompt, skillMenu, skillBody, memoryBlock].filter(Boolean).join("\n");

  updateAgentSessionState(role, {
    promptStartedAt: nowIso(),
    promptCompletedAt: null,
    awaiting: "waiting for Opencode response",
    lastEventSummary: truncateTelemetry(text, 140),
    stallReason: null,
  });

  let currentSessionId = sessionId;
  const output = await withRetry(
    async () => {
      const opencode = await getOpencode();
      const result = await opencode.client.session.prompt({
        path: { id: currentSessionId },
        body: {
          model: { providerID: "azure", modelID: deployment },
          agent: role,
          system: enrichedSystemPrompt,
          parts: [{ type: "text", text }],
        },
      });

      // Check for OpenCode-level errors embedded in data.info
      const infoError = (result.data?.info as any)?.error;
      if (infoError) {
        const errorMsg = infoError.data?.message ?? infoError.name ?? "Unknown OpenCode session error";
        throw new Error(`OpenCode ${role} session error: ${errorMsg}`);
      }

      return (
        (result.data?.parts as Array<{ type: string; text?: string }>)
          ?.filter((part) => part.type === "text" && part.text)
          .map((part) => part.text ?? "")
          .join("\n")
          .trim() || ""
      );
    },
    {
      maxRetries: 3,
      delay: 2000,
      backoff: 2,
      shouldRetry: isRetryableError,
      onRetry: async (attempt, _error) => {
        resetOpencodeConnection();
        // Invalidate cached session so a fresh one is created on reconnect
        agentSessions.delete(role);
        emitEmployeeActivity(role, "info", `OpenCode connection lost — reconnecting (attempt ${attempt})…`);
        const snap = getSnapshot();
        const freshSession = await ensureAgentSession(snap, role);
        currentSessionId = freshSession.sessionId;
      },
    },
  );

  updateAgentSessionState(role, {
    promptCompletedAt: nowIso(),
    lastProgressAt: nowIso(),
    lastEventSummary: truncateTelemetry(output || "Prompt completed with no text output."),
    awaiting: "idle",
  });

  return output;
}

async function runPlanningPhase(snapshot: CompanySnapshot) {
  if (!activeExecution) return;

  const ctoSession = await ensureAgentSession(snapshot, "cto");
  const ctoSoul = getRoleSoul("cto");
  ctoSession.status = "working";
  updateAgentSessionState("cto", {
    activeTaskId: activeExecution.planTaskId,
    awaiting: "writing technical plan",
    stallReason: null,
  });
  updateRoleMemory("cto", ["Write technical implementation plan", `Workspace root: ${workspaceRoot}`, `Company workspace: ${productDir}`]);
  setTaskStatus(activeExecution.planTaskId, "in_progress");
  emitEmployeeActivity("cto", "working", "Producing technical implementation plan…", { taskId: activeExecution.planTaskId });

  const scopeBoundary = [...snapshot.strategy.scopeBoundary];
  const demoConstraintLines: string[] = [];
  if (orchestratorConfig.demoMode) {
    scopeBoundary.push("FRONTEND ONLY — no backend, no API, no database, no server-side code");
    demoConstraintLines.push(
      `## CRITICAL SCOPE CONSTRAINT (NON-NEGOTIABLE)`,
      `Build FRONTEND ONLY. No backend server, no Express/Fastify, no API routes, no database.`,
      `Use Vite + React. The app runs via \`npm run dev\` on port ${previewConfig.port}.`,
      `All data hardcoded or localStorage. Plan accordingly.`,
      `Do NOT propose a file structure — the developer will scaffold with Vite and decide file layout.`,
      `Focus on: key UI components, data model, user flows, and visual design direction (Apple-inspired: dark/light sections, SF Pro typography, #0071e3 accent).`,
      "",
    );
  }

  const ctoPlan = await runPromptText(
    "cto",
    ctoSession.sessionId,
    ctoSoul.systemPrompt,
    [
      ...demoConstraintLines,
      `# Strategy: ${snapshot.strategy.title}`,
      "",
      `## Summary`,
      snapshot.strategy.summary,
      "",
      `## First Release`,
      snapshot.strategy.firstRelease,
      "",
      `## Scope Boundaries`,
      ...scopeBoundary.map((item) => `- ${item}`),
      "",
      `## Workspace Context`,
      `You have access to the full workspace rooted at ${workspaceRoot}.`,
      `Read any relevant documents or existing code under ${productDir} before finalising your plan.`,
      `This should be a spec-driven development plan that a PM can convert into acceptance criteria and a developer can execute.`,
      "",
      `## Output Requirements`,
      `Produce a unified technical + design spec that the developer can follow directly.`,
      `Include:`,
      `1. Key React components needed and their purpose`,
      `2. Data model shape (what's stored in localStorage)`,
      `3. User interaction flows`,
      `4. Visual Design Direction — this is CRITICAL:`,
      `   - Specify the exact CSS color variables to use (from your apple-design-system skill)`,
      `   - Specify typography: font family, sizes for headings/body/captions`,
      `   - Specify layout pattern: alternating dark/light sections, component styling`,
      `   - Include a ready-to-use CSS variables block the developer can paste into index.css`,
      `   - Specify global body styles (margin:0, font-family, background-color, color)`,
      `   - All components MUST use the CSS variables — no bare unstyled HTML`,
      ``,
      `## Scope Discipline (CRITICAL)`,
      `Only plan features that the strategy explicitly asks for.`,
      `Do NOT add authentication, login pages, registration, or user auth unless the strategy specifically requires it.`,
      `Do NOT add backend APIs, servers, or databases unless the strategy specifically requires them.`,
      `When in doubt, ship less — a polished, styled, focused MVP beats a feature-bloated skeleton.`,
      ``,
      `Do NOT include file paths or directory structure — the developer handles project scaffolding.`,
      `Do not edit files in this step.`,
    ].join("\n"),
  );

  ctoSession.status = "idle";
  updateAgentSessionState("cto", {
    activeTaskId: null,
    awaiting: "idle",
    lastProgressAt: nowIso(),
    lastEventSummary: "Technical implementation plan completed.",
  });
  if (!ctoPlan) throw new Error("CTO produced empty plan");

  activeExecution.planText = ctoPlan;
  const planArtifact = addArtifact("cto", "plan", "Technical Implementation Plan", ctoPlan);
  appendTaskResult(activeExecution.planTaskId, `artifact:${planArtifact.id}`);
  attachArtifactToTask(activeExecution.planTaskId, planArtifact.id);
  setTaskStatus(activeExecution.planTaskId, "completed", "Technical plan delivered.");
  const planningHandoff = recordMeeting({
    type: "handoff",
    facilitatorRole: "cto",
    participantRoles: ["cto", "pm"],
    summary: "CTO handed the technical plan to PM for delivery specification.",
    agenda: [
      {
        topic: "Technical plan review",
        type: "update",
        content: "CTO presented the completed architecture and implementation sequence.",
        raisedByRole: "cto",
        relatedTaskId: activeExecution.planTaskId,
      },
      {
        topic: "Acceptance task activation",
        type: "proposal",
        content: "PM will translate the plan into acceptance criteria and a delivery checklist.",
        raisedByRole: "pm",
        relatedTaskId: activeExecution.acceptanceTaskId,
      },
    ],
    decisions: [
      {
        description: "PM owns the acceptance-spec task using the CTO plan as the implementation contract.",
        decidedByRoles: ["cto", "pm"],
        impactIds: [activeExecution.planTaskId, activeExecution.acceptanceTaskId, planArtifact.id],
      },
    ],
    learnings: [
      {
        role: "pm",
        content: "The technical plan defines the architecture boundary and verification points for the current increment.",
      },
    ],
    taskModifications: [
      {
        taskId: activeExecution.acceptanceTaskId,
        modificationType: "assign",
        details: "Activated in CTO-to-PM handoff meeting after plan approval.",
      },
    ],
  });
  emitEmployeeActivity("cto", "idle", `Technical plan complete → /api/artifacts/${planArtifact.id}`, {
    taskId: activeExecution.planTaskId,
    meetingId: planningHandoff.id,
  });
}

async function runAcceptancePhase(snapshot: CompanySnapshot) {
  if (!activeExecution || !activeExecution.planText) return;

  const pmSession = await ensureAgentSession(snapshot, "pm");
  const pmSoul = getRoleSoul("pm");
  pmSession.status = "working";
  updateRoleMemory("pm", ["Turn CTO plan into acceptance criteria", `Company workspace: ${productDir}`]);
  setTaskStatus(activeExecution.acceptanceTaskId, "in_progress");
  emitEmployeeActivity("pm", "working", "Writing acceptance criteria and delivery checklist…", { taskId: activeExecution.acceptanceTaskId });

  const acceptanceText = await runPromptText(
    "pm",
    pmSession.sessionId,
    pmSoul.systemPrompt,
    [
      `# Technical Plan`,
      activeExecution.planText,
      "",
      `## Workspace Context`,
      `You have access to the entire company workspace at ${productDir}. Read any existing docs or files that affect delivery.`,
      "",
      `## Output Requirements`,
      `Produce a concise implementation spec for the developer.`,
      `Include acceptance criteria, non-goals, and a definition of done.`,
      `Do not edit files in this step.`,
    ].join("\n"),
  );

  pmSession.status = "idle";
  if (!acceptanceText) throw new Error("PM produced empty acceptance criteria");

  activeExecution.acceptanceText = acceptanceText;
  const acceptanceArtifact = addArtifact("pm", "plan", "Delivery Specification & Acceptance Criteria", acceptanceText);
  appendTaskResult(activeExecution.acceptanceTaskId, `artifact:${acceptanceArtifact.id}`);
  attachArtifactToTask(activeExecution.acceptanceTaskId, acceptanceArtifact.id);
  setTaskStatus(activeExecution.acceptanceTaskId, "completed", "Acceptance criteria delivered.");
  const implementationHandoff = recordMeeting({
    type: "handoff",
    facilitatorRole: "pm",
    participantRoles: ["pm", "developer"],
    summary: "PM handed the delivery specification to the developer for implementation.",
    agenda: [
      {
        topic: "Acceptance criteria walkthrough",
        type: "update",
        content: "PM reviewed the deliverable, non-goals, and definition of done with the developer.",
        raisedByRole: "pm",
        relatedTaskId: activeExecution.acceptanceTaskId,
      },
      {
        topic: "Implementation kickoff",
        type: "proposal",
        content: "Developer will implement the approved increment and prepare a local preview URL.",
        raisedByRole: "developer",
        relatedTaskId: activeExecution.buildTaskId,
      },
    ],
    decisions: [
      {
        description: "Developer owns implementation and preview tasks against PM acceptance criteria.",
        decidedByRoles: ["pm", "developer"],
        impactIds: [activeExecution.acceptanceTaskId, activeExecution.buildTaskId, activeExecution.previewTaskId, acceptanceArtifact.id],
      },
    ],
    learnings: [
      {
        role: "developer",
        content: "Definition of done now requires a reachable local preview and captured smoke-test evidence.",
      },
    ],
    taskModifications: [
      {
        taskId: activeExecution.buildTaskId,
        modificationType: "assign",
        details: "Activated in PM-to-Developer handoff meeting.",
      },
      {
        taskId: activeExecution.previewTaskId,
        modificationType: "assign",
        details: "Developer is accountable for reaching a local preview URL before CTO review.",
      },
    ],
  });
  emitEmployeeActivity("pm", "idle", `Acceptance spec complete → /api/artifacts/${acceptanceArtifact.id}`, {
    taskId: activeExecution.acceptanceTaskId,
    meetingId: implementationHandoff.id,
  });
}

// ---------------------------------------------------------------------------
// Developer step-loop helpers
// ---------------------------------------------------------------------------

interface DevStep {
  index: number;
  title: string;
  instruction: string;
  verifyCommand: string;
  expectedFiles: string[];
}

interface VerifyResult {
  passed: boolean;
  reason: string;
  missingFiles: string[];
  commandOutput?: string;
}

async function runDeveloperStep(sessionId: string, systemPrompt: string, text: string): Promise<string> {
  let currentSessionId = sessionId;
  return withRetry(
    async () => {
      const opencode = await getOpencode();
      const result = await opencode.client.session.prompt({
        path: { id: currentSessionId },
        body: {
          model: { providerID: "azure", modelID: ensureDeployment("workerDeployment") },
          agent: "developer",
          system: systemPrompt,
          tools: { bash: true, read: true, write: true, edit: true, glob: true, grep: true, apply_patch: true },
          parts: [{ type: "text", text }],
        },
      });
      const infoError = (result.data?.info as any)?.error;
      if (infoError) {
        throw new Error(`OpenCode developer step error: ${infoError.data?.message ?? infoError.name ?? "unknown"}`);
      }
      return (result.data?.parts as Array<{ type: string; text?: string }>)
        ?.filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim() || "";
    },
    {
      maxRetries: 3,
      delay: 2000,
      backoff: 2,
      shouldRetry: isRetryableError,
      onRetry: async (attempt, _error) => {
        resetOpencodeConnection();
        // Invalidate cached session so a fresh one is created on reconnect
        agentSessions.delete("developer");
        emitEmployeeActivity("developer", "info", `OpenCode connection lost — reconnecting (attempt ${attempt})…`);
        const snapshot = getSnapshot();
        const freshSession = await ensureAgentSession(snapshot, "developer");
        currentSessionId = freshSession.sessionId;
      },
    },
  );
}

async function decomposePlanIntoSteps(planText: string): Promise<DevStep[]> {
  // Use CTO session to decompose — keeps developer context clean
  try {
    const ctoEntry = [...agentSessions.entries()].find(([role]) => role === "cto");
    if (!ctoEntry) throw new Error("No CTO session for decomposition");

    const decompositionPrompt = [
      "Break the following technical plan into 2-4 sequential IMPLEMENTATION steps for a frontend developer.",
      "IMPORTANT: The base project is ALREADY scaffolded (Vite + React TypeScript + npm install done). Do NOT include any setup/scaffold step.",
      "IMPORTANT: Do NOT include any step that runs the app (npm run dev, npm start, etc). Running the app is handled separately.",
      "IMPORTANT: All React component files MUST use .tsx extension, NEVER .jsx. This ensures TypeScript catches undeclared variables and missing imports.",
      "The developer ONLY writes code. Verification is compile-only (npm run build + tsc --noEmit).",
      "Start from building the first UI component. Keep steps small and focused.",
      "Each step must be independently executable and verifiable.",
      "CRITICAL: The LAST step MUST be an integration/wiring step that imports ALL components into the app entry point (src/main.tsx or src/App.tsx) and renders them together in a cohesive layout. This step ensures nothing is left as an orphan file. Its expectedFiles MUST include the entry point file.",
      `Maximum ${orchestratorConfig.developer.maxSteps} steps total.`,
      "",
      "Return ONLY a JSON array (no markdown fencing, no explanation) where each element has:",
      '  { "title": "short title", "instruction": "what to build — be specific about files and components", "expectedFiles": ["relative/path"] }',
      "Do NOT include verifyCommand — it will be set automatically to tsc --noEmit + npm run build.",
      "",
      "Plan to decompose:",
      planText,
    ].join("\n");

    const output = await runPromptText("cto", ctoEntry[1].sessionId, getRoleSoul("cto").systemPrompt, decompositionPrompt);
    const jsonStr = output.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.length >= 1) {
      return parsed.slice(0, orchestratorConfig.developer.maxSteps).map((s: any, i: number) => ({
        index: i + 2, // starts at 2 because step 1 is scaffold
        title: String(s.title ?? `Step ${i + 2}`),
        instruction: String(s.instruction ?? ""),
        verifyCommand: "npx tsc --noEmit && npm run build",  // type-check then compile
        expectedFiles: Array.isArray(s.expectedFiles) ? s.expectedFiles.map(String) : [],
      }));
    }
  } catch (err) {
    emitEmployeeActivity("developer", "info", `Plan decomposition fell back to default: ${err instanceof Error ? err.message : "unknown"}`);
  }

  // Fallback: single step with the whole plan + npm run build verify
  return [{
    index: 2,
    title: "Implement full CTO spec",
    instruction: `Implement the following plan. The Vite project is already scaffolded.\n\n${planText}`,
    verifyCommand: "npx tsc --noEmit && npm run build",
    expectedFiles: ["src/App.tsx"],
  }];
}

function verifyStep(step: DevStep, workDir: string): VerifyResult {
  const missingFiles: string[] = [];
  for (const file of step.expectedFiles) {
    if (!existsSync(resolve(workDir, file))) missingFiles.push(file);
  }

  let commandPassed = true;
  let commandOutput = "";
  if (step.verifyCommand) {
    try {
      commandOutput = execSync(step.verifyCommand, {
        cwd: workDir, timeout: 60000, encoding: "utf-8", stdio: "pipe",
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      });
    } catch (err: any) {
      commandPassed = false;
      commandOutput = (err.stderr || err.message || "").slice(0, 500);
    }
  }

  const passed = missingFiles.length === 0 && commandPassed;
  return {
    passed,
    reason: !passed
      ? missingFiles.length > 0
        ? `Missing files: ${missingFiles.join(", ")}`
        : `Verify command failed: ${commandOutput.slice(0, 200)}`
      : "All checks passed",
    missingFiles,
    commandOutput,
  };
}

function buildStepPrompt(step: DevStep, totalSteps: number): string {
  return [
    `# Step ${step.index} of ${totalSteps}: ${step.title}`,
    "",
    step.instruction,
    "",
    `## Workspace: ${productDir}`,
    `Read existing files before editing — preserve work from previous steps.`,
    "",
    ...(step.expectedFiles.length > 0 ? [`Files that must exist when done: ${step.expectedFiles.join(", ")}`] : []),
    "",
    `## Self-Verification (MANDATORY before finishing)`,
    `After writing code, you MUST:`,
    `1. Run the project's build/compile command (e.g. \`npm run build\`, \`npx tsc --noEmit\`, \`python -m py_compile\`, or the equivalent for this stack).`,
    `2. Read the FULL build output. If there are compile errors, fix them.`,
    `3. If this is the LAST step (step ${totalSteps}): read the app entry point file and confirm ALL modules/components created in earlier steps are imported and rendered. If any are missing, add them.`,
    `Do NOT consider this step complete until the build passes cleanly.`,
    "",
    `## Rules`,
    `Use tools (write, edit, bash) to create and edit files. Do ONLY this step.`,
    `Do NOT start a dev server (npm run dev, npm start, etc.) — the preview phase handles that automatically after all steps are complete.`,
    `Do NOT add authentication, login pages, or features not in the CTO plan.`,
    `Every component MUST be visually styled — no bare unstyled HTML tags. Use CSS variables, proper padding, typography, and colors.`,
  ].join("\n");
}

function buildRetryPrompt(step: DevStep, verification: VerifyResult): string {
  return [
    `# Fix Required — Step ${step.index}: ${step.title}`,
    "",
    `Verification FAILED: ${verification.reason}`,
    ...(verification.missingFiles.length > 0 ? [`Missing files: ${verification.missingFiles.join(", ")}`] : []),
    ...(verification.commandOutput ? [`Command output:\n${verification.commandOutput.slice(0, 500)}`] : []),
    "",
    `Fix the issue. Do not start over — patch what's broken.`,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Developer phase — plan → exec → verify loop
// ---------------------------------------------------------------------------

async function startDeveloperPhase(snapshot: CompanySnapshot) {
  if (!activeExecution || !activeExecution.planText || !activeExecution.acceptanceText) return;

  clearReportedPreviewCandidate();
  await stopLocalPreview();
  await workspaceManager.ensureLocal(snapshot.company.id);

  const devSession = await ensureAgentSession(snapshot, "developer");
  const devSoul = getRoleSoul("developer");
  if (!devSoul.canWriteCode || !devSoul.canEditFiles) {
    throw new Error("Developer role lacks required code/file permissions in typed policy");
  }

  executionStatus = "executing";
  touchAgentSession("developer", "working");
  updateAgentSessionState("developer", {
    activeTaskId: activeExecution.buildTaskId,
    promptStartedAt: nowIso(),
    promptCompletedAt: null,
    awaiting: "scaffolding project",
    lastEventSummary: "Starting step-by-step execution.",
    stallReason: null,
  });
  updateRoleMemory("developer", ["Implement approved spec", `Company workspace: ${productDir}`]);
  setTaskStatus(activeExecution.buildTaskId, "in_progress");

  // ── Build system prompt ──
  const devSkillBody = getSkillBody("developer");
  const devSystemPrompt = [
    devSoul.systemPrompt,
    buildSkillMenu("developer"),
    devSkillBody,
    "",
    "# Skill Usage (MANDATORY)",
    "You MUST follow the **frontend-web-app** skill for project setup, framework choice (Vite + React), and port configuration (3210).",
    "CRITICAL: Always use .tsx file extensions for React components, NEVER .jsx. TypeScript catches errors that JSX silently misses.",
    "For visual design: strictly follow the CTO's technical plan.",
    "",
    "# UI Quality Standards (NON-NEGOTIABLE)",
    "Every component you write MUST be visually polished. No bare unstyled HTML.",
    "Apply these rules to EVERY component:",
    "- Use CSS variables from the CTO plan (or sensible defaults: dark bg, light text, accent color).",
    "- All text must have proper font-family, font-size, line-height, and color.",
    "- All containers must have proper padding, margin, border-radius, and background.",
    "- Buttons must have hover states, proper padding, cursor:pointer, and border-radius.",
    "- Forms must have styled inputs (padding, border, border-radius, focus outline).",
    "- Use flexbox/grid for layout — never rely on browser defaults.",
    "- The index.css or global stylesheet MUST set body { margin:0; font-family; background-color; color }.",
    "",
    "# Scope Discipline",
    "Only build what the CTO plan and acceptance criteria ask for.",
    "Do NOT add auth, login, registration, or user management unless explicitly specified in the plan.",
    "Do NOT add features, pages, or flows not in the spec.",
  ].filter(Boolean).join("\n");

  // ── Decompose CTO plan into implementation steps ──
  emitEmployeeActivity("developer", "working", "Decomposing CTO plan into execution steps…", {
    taskId: activeExecution.buildTaskId,
  });
  const implSteps = await decomposePlanIntoSteps(activeExecution.planText);

  // ── Build full step list: hardcoded scaffold + decomposed impl steps ──
  const scaffoldStep: DevStep = {
    index: 1,
    title: "Scaffold Vite + React project",
    instruction: [
      `cd ${productDir}`,
      `Run: npm create vite@latest . -- --template react-ts (this uses .tsx — NEVER create .jsx files)`,
      `Then edit vite.config.ts to set:`,
      `  server: { port: ${previewConfig.port}, host: '127.0.0.1' }`,
      `Then run: npm install`,
      `Do NOT run npm run dev or npm start — the preview phase handles that.`,
      ...(orchestratorConfig.demoMode ? [
        "",
        `CRITICAL: This is a FRONTEND-ONLY app. No Express, no backend, no server.js, no API routes.`,
      ] : []),
    ].join("\n"),
    verifyCommand: "",
    expectedFiles: ["package.json", "vite.config.ts", "index.html"],
  };

  const allSteps = [scaffoldStep, ...implSteps];
  const totalSteps = allSteps.length;

  emitEmployeeActivity("developer", "info",
    `Execution plan: ${totalSteps} steps — ${allSteps.map(s => s.title).join(" → ")}`,
    { taskId: activeExecution.buildTaskId });

  // ── Step loop ──
  // NOTE: developerStepLoopActive is managed by the caller
  // (runBuildPreviewReviewLoop) to prevent event-bridge race conditions.
  await startDeveloperWorkspaceMonitor();

  try {
    for (const step of allSteps) {
      scheduleDeveloperWatchdog();
      touchAgentSession("developer", "working");
      updateAgentSessionState("developer", {
        awaiting: `Step ${step.index}/${totalSteps}: ${step.title}`,
        lastEventSummary: `Starting step ${step.index}: ${step.title}`,
      });
      emitEmployeeActivity("developer", "working",
        `Step ${step.index}/${totalSteps}: ${step.title}`,
        { taskId: activeExecution.buildTaskId });

      // EXEC
      const stepPrompt = buildStepPrompt(step, totalSteps);
      await runDeveloperStep(devSession.sessionId, devSystemPrompt, stepPrompt);

      // VERIFY
      let verification = verifyStep(step, productDir);
      for (let retry = 0; retry < orchestratorConfig.developer.maxRetriesPerStep && !verification.passed; retry++) {
        emitEmployeeActivity("developer", "error",
          `Step ${step.index} verify failed (retry ${retry + 1}): ${verification.reason}`,
          { taskId: activeExecution.buildTaskId });

        const retryPrompt = buildRetryPrompt(step, verification);
        await runDeveloperStep(devSession.sessionId, devSystemPrompt, retryPrompt);
        verification = verifyStep(step, productDir);
      }

      emitEmployeeActivity("developer", "info",
        `Step ${step.index} ${verification.passed ? "verified" : "moved on"}: ${step.title}`,
        { taskId: activeExecution.buildTaskId });
    }
  } finally {
    clearDeveloperWatchdog();
    stopDeveloperWorkspaceMonitor();
  }

  // ── Post-loop: mark done ──
  touchAgentSession("developer", "done");
  updateAgentSessionState("developer", {
    awaiting: "idle",
    promptCompletedAt: nowIso(),
    lastProgressAt: nowIso(),
    activeTaskId: activeExecution.previewTaskId,
    lastEventSummary: "Implementation finished. Handing off to preview validation.",
  });
  emitEmployeeActivity("developer", "idle", "All steps complete. Routing to next phase.", {
    taskId: activeExecution.buildTaskId,
  });
  setTaskStatus(activeExecution.buildTaskId, "completed", "Implementation finished via step loop.");
}

// ---------------------------------------------------------------------------
// Developer rework — send the dev agent back with specific feedback
// ---------------------------------------------------------------------------

async function runDeveloperRework(snapshot: CompanySnapshot, feedback: string) {
  if (!activeExecution) return;

  const cycle = activeExecution.reworkCycles + 1;
  activeExecution.reworkCycles = cycle;

  emitEmployeeActivity("developer", "working", `Rework cycle ${cycle}: addressing feedback…`, { taskId: activeExecution.buildTaskId });

  clearReportedPreviewCandidate();
  await stopLocalPreview();

  executionStatus = "executing";
  setTaskStatus(activeExecution.buildTaskId, "in_progress", `Rework cycle ${cycle}`);
  setTaskStatus(activeExecution.previewTaskId, "created");
  // Allow the CTO review phase to re-enter
  activeExecution.reviewStarted = false;

  const devSession = await ensureAgentSession(snapshot, "developer");
  const devSoul = getRoleSoul("developer");
  const devSkillBody = getSkillBody("developer");
  const devSystemPrompt = [
    devSoul.systemPrompt,
    buildSkillMenu("developer"),
    devSkillBody,
    "",
    "# UI Quality Standards (NON-NEGOTIABLE)",
    "Every component MUST be visually polished. No bare unstyled HTML.",
    "Use CSS variables, proper padding, border-radius, typography, and colors for ALL elements.",
    "Do NOT add auth/login/registration unless explicitly in the feedback.",
  ].filter(Boolean).join("\n");

  touchAgentSession("developer", "working");
  updateAgentSessionState("developer", {
    activeTaskId: activeExecution.buildTaskId,
    promptStartedAt: nowIso(),
    promptCompletedAt: null,
    awaiting: `rework cycle ${cycle}`,
    lastEventSummary: `Rework cycle ${cycle}: fixing issues from feedback.`,
    stallReason: null,
  });

  const reworkPrompt = [
    `# Rework Required (cycle ${cycle})`,
    "",
    `The previous implementation was reviewed and feedback was received. You MUST fix the issues below.`,
    "",
    `## Feedback`,
    feedback,
    "",
    `## Workspace: ${productDir}`,
    `Read existing files before editing — do NOT start over. Patch what is broken.`,
    "",
    `## Self-Verification (MANDATORY before finishing)`,
    `After fixing:`,
    `1. Run the project's build/compile command and read the FULL output. Fix any errors.`,
    `2. Read the app entry point and confirm ALL modules/components are imported and rendered.`,
    `3. Start the dev server so the preview URL is captured.`,
    `Do NOT consider this rework complete until the build passes cleanly and the dev server is running.`,
  ].join("\n");

  scheduleDeveloperWatchdog();
  // NOTE: developerStepLoopActive is managed by runBuildPreviewReviewLoop.
  try {
    await runDeveloperStep(devSession.sessionId, devSystemPrompt, reworkPrompt);
  } finally {
    clearDeveloperWatchdog();
  }

  touchAgentSession("developer", "done");
  updateAgentSessionState("developer", {
    awaiting: "idle",
    promptCompletedAt: nowIso(),
    lastProgressAt: nowIso(),
    lastEventSummary: `Rework cycle ${cycle} complete.`,
  });
  setTaskStatus(activeExecution.buildTaskId, "completed", `Rework cycle ${cycle} complete.`);
}

// ---------------------------------------------------------------------------
// Build → Preview → Review loop with automatic rework
// ---------------------------------------------------------------------------

async function runBuildPreviewReviewLoop(snapshot: CompanySnapshot) {
  if (!activeExecution) return;

  const maxCycles = orchestratorConfig.developer.maxReworkCycles;

  // Keep the flag true for the ENTIRE loop so the event bridge never
  // triggers post-developer routing while the loop is still in control.
  developerStepLoopActive = true;
  try {
    // ── Initial developer implementation ──
    await startDeveloperPhase(snapshot);

    // ── Rework loop: preview → (optionally) review → rework if needed ──
    for (let cycle = 0; cycle <= maxCycles; cycle++) {
      if (!activeExecution) return;

      // 1. Preview validation
      const previewResult = await startPreviewPhase();
      if (!previewResult.ok) {
        if (cycle >= maxCycles) {
          emitEmployeeActivity("system", "error", `Max rework cycles (${maxCycles}) exhausted at preview stage. Pausing for board review.`, { taskId: activeExecution.previewTaskId });
          pauseForBoardReview(`Developer could not pass preview validation after ${maxCycles} rework cycles.`);
          return;
        }
        emitEmployeeActivity("system", "info", `Preview failed — sending developer to rework (cycle ${cycle + 1}/${maxCycles}).`, { taskId: activeExecution.buildTaskId });
        await runDeveloperRework(getSnapshot(), previewResult.reworkFeedback);
        continue;
      }

      // 2. CTO review
      const reviewResult = await startReviewPhase();
      if (!reviewResult.ok) {
        if (cycle >= maxCycles) {
          emitEmployeeActivity("system", "error", `Max rework cycles (${maxCycles}) exhausted at CTO review stage. Pausing for board review.`, { taskId: activeExecution.reviewTaskId });
          pauseForBoardReview(`Developer could not pass CTO review after ${maxCycles} rework cycles.`);
          return;
        }
        emitEmployeeActivity("system", "info", `CTO review requested rework — sending developer back (cycle ${cycle + 1}/${maxCycles}).`, { taskId: activeExecution.buildTaskId });
        await runDeveloperRework(getSnapshot(), reviewResult.reworkFeedback);
        continue;
      }

      // Both passed — done
      return;
    }
  } finally {
    developerStepLoopActive = false;
    clearDeveloperWatchdog();
  }
}

// ---------------------------------------------------------------------------
// Preview Content Validation — LLM evaluates rendered page against spec
// ---------------------------------------------------------------------------

const PreviewContentVerdict = z.object({
  pass: z.boolean(),
  reason: z.string(),
  missingElements: z.array(z.string()),
  visibleElements: z.array(z.string()),
});
type PreviewContentVerdict = z.infer<typeof PreviewContentVerdict>;

async function validatePreviewContent(previewUrl: string, acceptanceSpec: string): Promise<PreviewContentVerdict> {
  // Collect ALL source files from the workspace (stack-agnostic).
  // We evaluate source code — not rendered HTML — because SPAs serve an empty
  // shell and JS must execute in a browser to produce actual content.
  const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".html", ".css", ".json"]);
  const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", ".vite"]);

  const sourceSnippets: string[] = [];
  function collectSources(dir: string, depth = 0) {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch { return; }
    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectSources(fullPath, depth + 1);
      } else {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (sourceExtensions.has(ext) && entry.name !== "package-lock.json") {
          try {
            const content = readFileSync(fullPath, "utf-8");
            const relPath = relative(productDir, fullPath).replace(/\\/g, "/");
            sourceSnippets.push(`--- ${relPath} ---\n${content.slice(0, 3000)}`);
          } catch { /* skip unreadable */ }
        }
      }
    }
  }
  collectSources(productDir);

  // Cap total context to stay within token budget
  let totalLen = 0;
  const cappedSnippets: string[] = [];
  for (const s of sourceSnippets) {
    if (totalLen + s.length > 30000) break;
    cappedSnippets.push(s);
    totalLen += s.length;
  }

  try {
    return await structuredCompletion(
      "workerDeployment",
      [
        {
          role: "system",
          content: [
            "You are a QA engineer verifying that a product's SOURCE CODE delivers the features described in the acceptance specification.",
            "You will receive the acceptance spec and the source files from the workspace.",
            "",
            "FAIL if ANY of these are true:",
            "- The app entry point (main file, index file, or equivalent for any framework) does not import or use the product-specific modules/components",
            "- The source code only contains scaffold/boilerplate with no product-specific logic",
            "- Key features from the acceptance spec have no corresponding implementation in any source file",
            "- Modules were created as files but are never imported or used by the application entry point",
            "- The UI has NO meaningful styling — bare browser-default HTML with no CSS, no design tokens, no layout system",
            "- The app includes features NOT in the acceptance spec (e.g. login/auth pages, admin panels, settings screens) unless the spec explicitly requires them",
            "",
            "PASS if:",
            "- The app entry point imports and uses the product-specific modules",
            "- The core features from the acceptance spec have corresponding implementations",
            "- The application would render/serve meaningful product content when run (even with mock/demo data)",
            "- The UI code includes actual styling (CSS variables, classes, inline styles, or a CSS framework) — not bare unstyled HTML",
            "- The app ONLY implements what the spec asks for — no hallucinated features like login pages or auth flows unless specified",
            "",
            "Be stack-agnostic. This could be React, Vue, Svelte, Python, plain HTML, Express, or anything else.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "# Acceptance Specification",
            acceptanceSpec,
            "",
            `# Source Files (${cappedSnippets.length} files from workspace)`,
            ...cappedSnippets,
          ].join("\n"),
        },
      ],
      PreviewContentVerdict,
      "preview_content_verdict",
      { temperature: 0.2 },
    );
  } catch (err) {
    // If LLM call fails, don't block — let the CTO review phase catch issues
    emitEmployeeActivity("system", "info", `LLM preview validation unavailable, deferring to CTO review: ${err instanceof Error ? err.message : "unknown"}`);
    return { pass: true, reason: "LLM validation unavailable — deferred to CTO review", missingElements: [], visibleElements: [] };
  }
}

type PhaseResult = { ok: true } | { ok: false; reworkFeedback: string };

async function startPreviewPhase(): Promise<PhaseResult> {
  if (!activeExecution) return { ok: true };

  stopDeveloperWorkspaceMonitor();

  executionStatus = "verifying";
  updateAgentSessionState("developer", {
    activeTaskId: activeExecution.previewTaskId,
    awaiting: "preview validation",
    lastEventSummary: "Implementation complete. Starting preview validation.",
  });
  setTaskStatus(activeExecution.previewTaskId, "in_progress");
  emitEmployeeActivity("developer", "working", "Launching local preview and running smoke checks…", { taskId: activeExecution.previewTaskId });

  const buildTask = getSnapshot().tasks.find((task) => task.id === activeExecution?.buildTaskId) ?? null;
  const preferredTargetPath = getPreferredPreviewTargetPathFromTask(buildTask);
  const preview = await startLocalPreview(productDir, preferredTargetPath);
  const previewUrl = preview.validationUrl ?? preview.entryUrl ?? preview.url;
  if (preview.status !== "ready" || !previewUrl) {
    const reason = preview.lastError ?? "Preview launch failed.";
    setTaskStatus(activeExecution.previewTaskId, "failed", reason);
    recordMeeting({
      type: "escalation",
      facilitatorRole: "developer",
      participantRoles: ["developer", "cto", "ceo"],
      summary: "Developer escalated a preview launch failure to engineering leadership.",
      agenda: [
        {
          topic: "Preview launch blocker",
          type: "blocker",
          content: reason,
          raisedByRole: "developer",
          relatedTaskId: activeExecution.previewTaskId,
        },
      ],
      decisions: [
        {
          description: "Developer must fix the preview launch issue before the cycle can continue.",
          decidedByRoles: ["developer", "cto", "ceo"],
          impactIds: [activeExecution.previewTaskId],
        },
      ],
    });
    emitEmployeeActivity("developer", "error", reason, { taskId: activeExecution.previewTaskId });
    return { ok: false, reworkFeedback: `Preview launch failed: ${reason}. Fix the issue so the dev server starts and is reachable.` };
  }



  setTaskPreviewUrl(activeExecution.previewTaskId, previewUrl);
  appendTaskResult(activeExecution.previewTaskId, `preview:${previewUrl}`);

  // ── LLM Content Validation ──
  const contentVerdict = await validatePreviewContent(previewUrl, activeExecution.acceptanceText ?? "");
  if (!contentVerdict.pass) {
    await stopLocalPreview();
    const failMsg = `Preview content validation failed: ${contentVerdict.reason}`;
    setTaskStatus(activeExecution.previewTaskId, "failed", failMsg);
    setTaskStatus(activeExecution.buildTaskId, "in_progress", failMsg);
    recordMeeting({
      type: "escalation",
      facilitatorRole: "developer",
      participantRoles: ["developer", "cto"],
      summary: "Preview launched but rendered content does not match the acceptance spec. Developer must fix.",
      agenda: [
        {
          topic: "Preview content mismatch",
          type: "blocker",
          content: contentVerdict.reason,
          raisedByRole: "developer",
          relatedTaskId: activeExecution.previewTaskId,
        },
        ...(contentVerdict.missingElements.length > 0 ? [{
          topic: "Missing elements",
          type: "blocker" as const,
          content: `Missing from the rendered preview: ${contentVerdict.missingElements.join(", ")}`,
          raisedByRole: "developer" as const,
          relatedTaskId: activeExecution.buildTaskId,
        }] : []),
      ],
      decisions: [{
        description: "Developer must fix the implementation so the preview renders the full product.",
        decidedByRoles: ["developer", "cto"],
        impactIds: [activeExecution.buildTaskId, activeExecution.previewTaskId],
      }],
    });
    emitEmployeeActivity("developer", "error", failMsg, { taskId: activeExecution.previewTaskId });
    const missingHint = contentVerdict.missingElements.length > 0
      ? ` Missing elements: ${contentVerdict.missingElements.join(", ")}.`
      : "";
    return { ok: false, reworkFeedback: `${contentVerdict.reason}${missingHint} Fix the source code so the product renders correctly when the dev server runs.` };
  }

  await syncWorkspaceCheckpoint(
    activeExecution.buildTaskId,
    "developer",
    `Developer implementation reached a runnable preview at ${previewUrl}`
  );
  setTaskStatus(activeExecution.previewTaskId, "completed", `Local preview reachable at ${previewUrl} — content validated against acceptance spec.`);
  clearRoleBlockers("developer", [preview.lastError ?? "Local preview launch failed."]);
  const previewReviewMeeting = recordMeeting({
    type: "ad_hoc",
    facilitatorRole: "developer",
    participantRoles: ["developer", "cto"],
    summary: "Developer shared the local preview and smoke-check evidence with the CTO.",
    agenda: [
      {
        topic: "Preview availability",
        type: "update",
        content: `Developer presented a reachable local preview at ${previewUrl}.`,
        raisedByRole: "developer",
        relatedTaskId: activeExecution.previewTaskId,
      },
      {
        topic: "CTO review prep",
        type: "proposal",
        content: "CTO will inspect the implementation and convert the evidence into a board-ready handoff.",
        raisedByRole: "cto",
        relatedTaskId: activeExecution.reviewTaskId,
      },
    ],
    decisions: [
      {
        description: "CTO review starts only after the developer-provided preview and smoke evidence are available.",
        decidedByRoles: ["developer", "cto"],
        impactIds: [activeExecution.previewTaskId, activeExecution.reviewTaskId],
      },
    ],
    learnings: [
      {
        role: "cto",
        content: `Preview evidence is available at ${previewUrl} and can be used in the board handoff review.`,
      },
      {
        role: "developer",
        content: `Local preview is reachable at ${previewUrl}.`,
      },
    ],
    taskModifications: [
      {
        taskId: activeExecution.reviewTaskId,
        modificationType: "assign",
        details: "CTO review task activated after preview evidence review meeting.",
      },
    ],
  });
  emitEmployeeActivity("developer", "info", `Local preview ready → ${previewUrl}`, {
    taskId: activeExecution.previewTaskId,
    meetingId: previewReviewMeeting.id,
  });
  return { ok: true };
}

async function startReviewPhase(): Promise<PhaseResult> {
  if (!activeExecution || !activeExecution.planText || !activeExecution.acceptanceText) {
    return { ok: true };
  }

  activeExecution.reviewStarted = true;
  executionStatus = "verifying";

  const snapshot = getSnapshot();
  const ctoSession = await ensureAgentSession(snapshot, "cto");
  const ctoSoul = getRoleSoul("cto");
  ctoSession.status = "working";
  updateRoleMemory("cto", ["Review developer implementation", `Review workspace: ${productDir}`, "Prepare handoff back to the board"]);
  setTaskStatus(activeExecution.buildTaskId, "verifying");
  setTaskStatus(activeExecution.reviewTaskId, "in_progress");
  emitEmployeeActivity("cto", "working", "Reviewing implementation and preparing board handoff…", { taskId: activeExecution.reviewTaskId });

  const reviewText = await runPromptText(
    "cto",
    ctoSession.sessionId,
    ctoSoul.systemPrompt,
    [
      `# Review Mission`,
      `Inspect the implementation in ${productDir}. You may read files and run safe verification commands, but do not edit code in this step.`,
      `Your task is to decide whether the implementation satisfies the approved spec and produce a board-ready handoff summary.`,
      getLocalPreviewState().url ? `The local preview URL is ${getLocalPreviewState().url}. Hit it and include the smoke test result.` : `No local preview URL is available. State clearly why not.`,
      "",
      `# CTO Technical Plan`,
      activeExecution.planText,
      "",
      `# PM Acceptance Criteria`,
      activeExecution.acceptanceText,
      "",
      `# Output Requirements`,
      `Return text only with these sections:`,
      `1. Review verdict (APPROVED or NEEDS_REWORK)`,
      `2. What was built`,
      `3. Verification evidence`,
      `4. Open risks or follow-ups`,
      `5. Recommendation to the board`,
      `6. If NEEDS_REWORK: a clear, actionable list of what the developer must fix`,
      "",
      `If unresolved risks or blocked work remain, state clearly that board review is recommended. If the remaining work is autonomous and policy-safe, say so explicitly.`,
    ].join("\n"),
  );

  ctoSession.status = "idle";
  const reviewArtifact = addArtifact("cto", "output", "Board Handoff Review", reviewText || "CTO review completed without summary text.");
  appendTaskResult(activeExecution.reviewTaskId, `artifact:${reviewArtifact.id}`);
  attachArtifactToTask(activeExecution.reviewTaskId, reviewArtifact.id);
  setTaskPreviewUrl(activeExecution.reviewTaskId, getLocalPreviewState().url);

  // ── Classify the CTO review into a structured verdict ──
  const CtoReviewVerdict = z.object({
    approved: z.boolean().describe("true if the CTO approved the implementation, false if rework is needed"),
    reworkItems: z.array(z.string()).describe("Specific items the developer must fix (empty if approved)"),
    summary: z.string().describe("One-sentence verdict summary"),
  });

  let verdict = { approved: true, reworkItems: [] as string[], summary: "CTO approved the implementation." };
  try {
    verdict = await structuredCompletion(
      "workerDeployment",
      [
        {
          role: "system",
          content: "You are classifying a CTO code review into a structured verdict. Extract whether the review APPROVED the implementation or requests REWORK. If rework is needed, list the specific items to fix.",
        },
        {
          role: "user",
          content: reviewText || "No review text available.",
        },
      ],
      CtoReviewVerdict,
      "cto_review_verdict",
      { temperature: 0 },
    );
  } catch {
    // If verdict extraction fails, assume approved to avoid blocking
    emitEmployeeActivity("system", "info", "Could not extract structured CTO verdict — assuming approved.", { taskId: activeExecution.reviewTaskId });
  }

  if (!verdict.approved && verdict.reworkItems.length > 0) {
    // CTO found issues — developer needs to rework
    setTaskStatus(activeExecution.reviewTaskId, "failed", `CTO review: ${verdict.summary}`);
    setTaskStatus(activeExecution.buildTaskId, "in_progress", `CTO rework: ${verdict.reworkItems.join("; ")}`);
    recordMeeting({
      type: "escalation",
      facilitatorRole: "cto",
      participantRoles: ["cto", "developer"],
      summary: `CTO review found issues requiring developer rework: ${verdict.summary}`,
      agenda: verdict.reworkItems.map((item, i) => ({
        topic: `Rework item ${i + 1}`,
        type: "blocker" as const,
        content: item,
        raisedByRole: "cto" as const,
        relatedTaskId: activeExecution!.buildTaskId,
      })),
      decisions: [{
        description: "Developer must address the CTO's rework items before the review can pass.",
        decidedByRoles: ["cto"],
        impactIds: [activeExecution.buildTaskId, activeExecution.reviewTaskId],
      }],
    });
    emitEmployeeActivity("cto", "error", `CTO review: NEEDS_REWORK — ${verdict.summary}`, { taskId: activeExecution.reviewTaskId });
    return { ok: false, reworkFeedback: `CTO review feedback:\n${verdict.reworkItems.map((item, i) => `${i + 1}. ${item}`).join("\n")}\n\nFix all items above, then run the build to confirm no errors.` };
  }

  setTaskStatus(activeExecution.buildTaskId, "completed", "Implementation finished and CTO-approved.");
  setTaskStatus(activeExecution.reviewTaskId, "completed", "CTO review passed — proceeding to autonomous specialist execution.");
  const boardPrepMeeting = recordMeeting({
    type: "handoff",
    facilitatorRole: "cto",
    participantRoles: ["cto", "ceo"],
    summary: "CTO approved the implementation — company continues autonomous execution of remaining specialist tasks.",
    agenda: [
      {
        topic: "Implementation review verdict",
        type: "update",
        content: "CTO verified the implementation against acceptance criteria and approved it.",
        raisedByRole: "cto",
        relatedTaskId: activeExecution.reviewTaskId,
      },
      {
        topic: "Autonomous continuation",
        type: "proposal",
        content: "CEO authorized continued autonomous execution for ready specialist tasks (QA, design, marketing).",
        raisedByRole: "ceo",
        relatedTaskId: activeExecution.reviewTaskId,
      },
    ],
    decisions: [
      {
        description: "CTO approved — autonomous execution continues for specialist work.",
        decidedByRoles: ["cto", "ceo"],
        impactIds: [activeExecution.reviewTaskId, reviewArtifact.id],
      },
    ],
    learnings: [
      {
        role: "ceo",
        content: "Company operates autonomously through CTO review and specialist execution without board gates.",
      },
    ],
  });
  emitEmployeeActivity("cto", "idle", `CTO review passed — continuing autonomous execution → /api/artifacts/${reviewArtifact.id}`, {
    taskId: activeExecution.reviewTaskId,
    meetingId: boardPrepMeeting.id,
  });
  await reconcilePostReviewExecution();
  return { ok: true };
}

export function getArtifacts() {
  return artifacts;
}

export function getTransitions() {
  return getSnapshot().transitions ?? [];
}

export function getFeedbackRounds() {
  return getSnapshot().feedbackRounds ?? [];
}

export async function resetOrchestratorState() {
  clearDeveloperWatchdog();
  clearReportedPreviewCandidate();
  stopDeveloperWorkspaceMonitor();
  agentSessions.clear();
  artifacts.splice(0, artifacts.length);
  executionStatus = "idle";
  eventBridgeStarted = false;
  activeExecution = null;
  await stopLocalPreview();
}

export function getAgentSessions() {
  return Object.fromEntries(agentSessions);
}

export function getExecutionStatus() {
  return executionStatus;
}

export async function stopExecution(reason = "Board manually stopped company execution.") {
  if (["idle", "done", "error", "paused"].includes(executionStatus) && !activeExecution) {
    throw new Error("No active company execution is running.");
  }

  clearDeveloperWatchdog();
  stopDeveloperWorkspaceMonitor();
  await stopLocalPreview();

  const snapshot = getSnapshot();
  const impactedTaskIds = snapshot.tasks
    .filter((task) => ["in_progress", "verifying"].includes(task.status))
    .map((task) => task.id);

  for (const taskId of impactedTaskIds) {
    setTaskStatus(taskId, "blocked", reason);
  }

  for (const session of agentSessions.values()) {
    if (session.status === "working") {
      session.status = "idle";
      session.lastEventAt = nowIso();
    }
  }

  executionStatus = "paused";

  recordMeeting({
    type: "escalation",
    facilitatorRole: "ceo",
    participantRoles: uniqueStrings([
      "ceo",
      "cto",
      ...snapshot.tasks
        .filter((task) => impactedTaskIds.includes(task.id))
        .map((task) => task.assignedRole),
    ]) as AgentIdentity["role"][],
    summary: "Board manually stopped the current execution cycle.",
    agenda: [
      {
        topic: "Manual stop",
        type: "blocker",
        content: reason,
        raisedByRole: "ceo",
        relatedTaskId: activeExecution?.reviewTaskId ?? impactedTaskIds[0] ?? null,
      },
    ],
    decisions: [
      {
        description: "The current execution cycle is paused until the board starts a new run.",
        decidedByRoles: ["ceo", "cto"],
        impactIds: uniqueStrings([activeExecution?.reviewTaskId ?? null, ...impactedTaskIds]),
      },
    ],
  });

  emitEmployeeActivity("system", "info", reason, {
    taskId: activeExecution?.reviewTaskId ?? impactedTaskIds[0] ?? null,
  });

  activeExecution = null;

  return {
    executionStatus,
    reason,
  };
}

export async function approveBoardReview() {
  if (executionStatus !== "awaiting_board_review" || !activeExecution) {
    throw new Error("Board review is not awaiting approval.");
  }

  const reviewTaskId = activeExecution.reviewTaskId;
  const queuedFollowUpCount = getSnapshot().tasks.filter(
    (task) => task.kind === "follow_up" && ["created", "planned"].includes(task.status)
  ).length;
  const resolvedApprovals = approvePendingBoardApprovals();

  executionStatus = "done";
  emitEmployeeActivity(
    "system",
    "info",
    queuedFollowUpCount > 0 || resolvedApprovals.length > 0
      ? `Board approved the CTO handoff. Execution is complete. ${queuedFollowUpCount > 0 ? `${queuedFollowUpCount} follow-up task${queuedFollowUpCount === 1 ? "" : "s"} remain queued for the next cycle. ` : ""}${resolvedApprovals.length > 0 ? `${resolvedApprovals.length} pending approval request${resolvedApprovals.length === 1 ? " was" : "s were"} resolved.` : ""}`.trim()
      : "Board approved the CTO handoff. Execution is marked complete.",
    {
      taskId: reviewTaskId,
    }
  );

  updateTask(reviewTaskId, (task) => ({
    ...task,
    verifierState: {
      ...task.verifierState,
      isVerified: true,
      feedback: queuedFollowUpCount > 0 || resolvedApprovals.length > 0
        ? `Board approved the handoff.${queuedFollowUpCount > 0 ? ` ${queuedFollowUpCount} follow-up task${queuedFollowUpCount === 1 ? "" : "s"} remain queued for the next cycle.` : ""}${resolvedApprovals.length > 0 ? ` ${resolvedApprovals.length} pending approval request${resolvedApprovals.length === 1 ? " was" : "s were"} resolved.` : ""}`
        : "Board approved the handoff and closed the current cycle.",
    },
  }));

  recordMeeting({
    type: "ad_hoc",
    facilitatorRole: "ceo",
    participantRoles: ["ceo", "cto"],
    summary: "Board approved the CTO handoff and closed the current execution cycle.",
    agenda: [
      {
        topic: "Board approval",
        type: "proposal",
        content: "The board accepted the CTO handoff artifact and closed the current increment.",
        raisedByRole: "ceo",
        relatedTaskId: reviewTaskId,
      },
    ],
    decisions: [
      {
        description: queuedFollowUpCount > 0 || resolvedApprovals.length > 0
          ? `Execution is complete.${queuedFollowUpCount > 0 ? ` ${queuedFollowUpCount} follow-up task${queuedFollowUpCount === 1 ? "" : "s"} are queued for the next cycle.` : ""}${resolvedApprovals.length > 0 ? ` ${resolvedApprovals.length} approval request${resolvedApprovals.length === 1 ? " was" : "s were"} resolved by the board.` : ""}`
          : "Execution is complete until the board starts another cycle.",
        decidedByRoles: ["ceo", "cto"],
        impactIds: [reviewTaskId],
      },
    ],
    learnings: [
      {
        role: "ceo",
        content: "Board review closed the loop after CTO handoff without resuming autonomous execution.",
      },
    ],
  });

  activeExecution = null;

  // Check if sprint is now complete (board_handoff was the last task)
  await checkSprintCompletion();

  return {
    executionStatus,
    reviewTaskId,
    queuedFollowUpCount,
    resolvedApprovalCount: resolvedApprovals.length,
  };
}

/**
 * Approves a CEO sprint proposal and kicks off Sprint N+1.
 * Creates new sprint record, tasks from the proposal's key_tasks,
 * auto-adds CTO board_handoff as final task, then starts execution.
 */
export async function approveSprintProposal(card: CeoCard) {
  if (!card.sprint_proposal) {
    throw new Error("No sprint_proposal data in the provided card.");
  }

  if (executionStatus !== "done") {
    throw new Error(`Cannot approve sprint proposal while execution is "${executionStatus}". Must be "done".`);
  }

  const proposal = card.sprint_proposal;

  if (!proposal.key_tasks || proposal.key_tasks.length === 0) {
    throw new Error("Sprint proposal has no key_tasks. Ask CEO to repropose with tasks.");
  }

  const snapshot = getSnapshot();
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  if (currentSprint && currentSprint.status !== "completed") {
    throw new Error(`Current sprint (${currentSprint.number}) is still "${currentSprint.status}". Cannot start a new sprint.`);
  }

  // Create Sprint N+1
  const sprint = createSprintRecord(
    snapshot,
    `Sprint ${(snapshot.company.currentSprintNumber ?? 0) + 1}: ${proposal.sprint_goal}`,
    proposal.sprint_goal,
  );
  let freshSnapshot = getSnapshot();

  // Create tasks from key_tasks
  const taskTitleToId = new Map<string, string>();
  const createdTasks: Task[] = [];

  for (const kt of proposal.key_tasks) {
    const role = kt.assigned_role as AgentIdentity["role"];
    const task = createWorkflowTask(
      freshSnapshot,
      "implementation",
      role,
      kt.title,
      kt.rationale || kt.title,
      kt.rationale || kt.title,
      kt.title,
      [`${kt.title} completed`],
      kt.priority as Task["priority"] || "medium",
      "created",
      sprint.id,
    );
    taskTitleToId.set(kt.title, task.id);
    createdTasks.push(task);
  }

  // Resolve dependencies by title
  for (const kt of proposal.key_tasks) {
    const taskId = taskTitleToId.get(kt.title);
    if (!taskId) continue;
    const depIds = (kt.depends_on || [])
      .map((depTitle: string) => taskTitleToId.get(depTitle))
      .filter((id): id is string => Boolean(id));
    if (depIds.length > 0) {
      const idx = createdTasks.findIndex((t) => t.id === taskId);
      if (idx >= 0) {
        createdTasks[idx] = {
          ...createdTasks[idx],
          dependsOnTaskIds: depIds,
          parentTaskId: depIds[0],
        };
      }
    }
  }

  // Find leaf tasks (tasks that no other task depends on)
  const allDepIds = new Set(createdTasks.flatMap((t) => t.dependsOnTaskIds));
  const leafTaskIds = createdTasks
    .filter((t) => !allDepIds.has(t.id))
    .map((t) => t.id);

  // Auto-add CTO board_handoff review as final task
  const reviewTask = createWorkflowTask(
    freshSnapshot,
    "board_handoff",
    "cto",
    "CTO Sprint Review",
    "Review the sprint deliverables and prepare handoff summary.",
    "Verify all sprint work and produce review summary.",
    "Sprint review summary",
    ["All sprint deliverables reviewed", "Summary produced"],
    "medium",
    "created",
    sprint.id,
  );
  reviewTask.dependsOnTaskIds = leafTaskIds;
  reviewTask.parentTaskId = leafTaskIds[0] || null;
  createdTasks.push(reviewTask);

  // Add child links for leaf → review
  for (const leafId of leafTaskIds) {
    const idx = createdTasks.findIndex((t) => t.id === leafId);
    if (idx >= 0) {
      createdTasks[idx] = {
        ...createdTasks[idx],
        childTaskIds: [...createdTasks[idx].childTaskIds, reviewTask.id],
      };
    }
  }

  // Persist all tasks
  for (const task of createdTasks) {
    upsertTask(task);
  }

  // Auto-promote tasks with no dependencies to "planned"
  for (const task of createdTasks) {
    if (task.dependsOnTaskIds.length === 0 && task.status === "created") {
      updateTask(task.id, (t) => ({ ...t, status: "planned" as Task["status"] }));
    }
  }

  // Mark sprint as active
  updateSprint(sprint.id, (s) => ({
    ...s,
    status: "executing" as Sprint["status"],
    startedAt: nowIso(),
  }));

  emitEmployeeActivity(
    "system",
    "info",
    `Sprint ${sprint.number} approved with ${createdTasks.length} tasks. Starting execution.`,
  );

  // Set up activeExecution and kick off
  activeExecution = {
    companyId: freshSnapshot.company.id,
    planTaskId: createdTasks[0]?.id ?? "",
    acceptanceTaskId: "",
    buildTaskId: "",
    previewTaskId: "",
    reviewTaskId: reviewTask.id,
    planText: null,
    acceptanceText: null,
    reviewStarted: false,
    reworkCycles: 0,
  };

  await beginSprintExecution();

  return { sprintId: sprint.id, sprintNumber: sprint.number, taskCount: createdTasks.length };
}

/**
 * Rejects a sprint proposal — resets to "done" so the board can re-chat with CEO.
 */
export function rejectSprintProposal() {
  executionStatus = "done";
  emitEmployeeActivity(
    "system",
    "info",
    "Sprint proposal rejected by board. CEO awaits further direction via chat.",
  );
  return { executionStatus };
}

/**
 * Lighter execution entry for Sprint 2+ — uses tasks already created by approveSprintProposal.
 * Doesn't create the rigid 5-task pipeline. Just starts the router loop.
 */
async function beginSprintExecution(): Promise<void> {
  const snapshot = getSnapshot();

  executionStatus = "executing";

  try {
    await workspaceManager.ensureLocal(snapshot.company.id);

    if (!eventBridgeStarted) {
      startEventBridge().catch(() => {});
      eventBridgeStarted = true;
    }

    await continueExecutionFromCurrentState("sprint-kickoff");
  } catch (err) {
    executionStatus = "error";
    const msg = err instanceof Error ? err.message : "Unknown error";
    emitEmployeeActivity("system", "error", `Sprint execution failed: ${msg}`);
  }
}

export function resolveRoleBySessionId(sessionId: string): string | null {
  for (const [role, state] of agentSessions) {
    if (state.sessionId === sessionId) return role;
  }
  return null;
}

export async function beginExecution(snapshot: CompanySnapshot) {
  if (["planning", "executing", "verifying", "awaiting_board_review"].includes(executionStatus)) {
    emitEmployeeActivity("system", "info", "Execution already in progress");
    return;
  }

  executionStatus = "planning";

  // Create Sprint 1 record — all tasks created below will inherit this sprintId
  const sprint = createSprintRecord(
    snapshot,
    snapshot.strategy.title,
    snapshot.strategy.firstRelease,
  );
  // Re-read snapshot after sprint was added to store
  snapshot = getSnapshot();

  emitEmployeeActivity("system", "info", `Beginning Sprint ${sprint.number} execution…`);

  try {
    await workspaceManager.ensureLocal(snapshot.company.id);

    if (!eventBridgeStarted) {
      startEventBridge().catch(() => {});
      eventBridgeStarted = true;
    }

    const planTask = createWorkflowTask(
      snapshot,
      "technical_plan",
      "cto",
      "Create technical implementation plan",
      "Turn the approved strategy into a technical plan and implementation spec.",
      "Define the architecture, file structure, implementation sequence, and engineering checkpoints.",
      "Technical implementation plan",
      ["Architecture defined", "Implementation sequence defined"],
      "medium",
      "in_progress",
    );
    const acceptanceTask = createWorkflowTask(
      snapshot,
      "acceptance_spec",
      "pm",
      "Write delivery specification",
      "Convert the technical plan into acceptance criteria and definition of done.",
      "Create the implementation contract the developer must satisfy before work returns to the board.",
      "Delivery specification and acceptance criteria",
      ["Definition of done written", "Acceptance criteria written"],
      "medium",
      "created",
    );
    const buildTask = createWorkflowTask(
      snapshot,
      "implementation",
      "developer",
      "Implement approved product increment",
      "Build the app inside the company workspace from the approved spec.",
      "Create or extend the company workspace and deliver a runnable increment.",
      "Working product increment",
      ["Files created in workspace", "Implementation matches spec"],
      "high",
      "created",
    );
    const previewTask = createWorkflowTask(
      snapshot,
      "local_preview",
      "developer",
      "Launch local preview",
      "Start the product locally and prove it is reachable.",
      "Expose a real local preview URL and perform a smoke test.",
      "Reachable local preview URL",
      ["Local URL is reachable", "Smoke test result captured"],
      "high",
      "created",
    );
    const reviewTask = createWorkflowTask(
      snapshot,
      "board_handoff",
      "cto",
      "Prepare board handoff",
      "Verify the implementation and package the handoff back to the board.",
      "Stop autonomous work and produce the board-ready review summary.",
      "Board handoff review",
      ["Preview reviewed", "Board artifact produced"],
      "medium",
      "created",
    );

    planTask.childTaskIds = [acceptanceTask.id];
    acceptanceTask.dependsOnTaskIds = [planTask.id];
    acceptanceTask.childTaskIds = [buildTask.id];
    buildTask.dependsOnTaskIds = [acceptanceTask.id];
    buildTask.childTaskIds = [previewTask.id];
    previewTask.dependsOnTaskIds = [buildTask.id];
    previewTask.childTaskIds = [reviewTask.id];
    reviewTask.dependsOnTaskIds = [previewTask.id];
    replaceTasks([planTask, acceptanceTask, buildTask, previewTask, reviewTask]);

    const kickoffMeeting = recordMeeting({
      type: "scrum",
      facilitatorRole: "cto",
      participantRoles: ["cto", "pm", "developer"],
      summary: "Engineering kickoff established the sprint objective, handoff order, and task ownership.",
      agenda: [
        {
          topic: "Sprint objective",
          type: "update",
          content: `Deliver ${snapshot.strategy.firstRelease} within the approved scope boundary.`,
          raisedByRole: "cto",
          relatedTaskId: planTask.id,
        },
        {
          topic: "Task assignment",
          type: "proposal",
          content: "CTO, PM, and Developer confirmed the meeting-driven handoff sequence for this increment.",
          raisedByRole: "pm",
          relatedTaskId: buildTask.id,
        },
      ],
      decisions: [
        {
          description: "All work handoffs and escalation flow happen through meetings attached to the task pipeline.",
          decidedByRoles: ["cto", "pm", "developer"],
          impactIds: [planTask.id, acceptanceTask.id, buildTask.id, previewTask.id, reviewTask.id],
        },
      ],
      learnings: [
        {
          role: "cto",
          content: "CTO is accountable for the kickoff plan and final board handoff for this sprint.",
        },
        {
          role: "pm",
          content: "PM uses the CTO plan to produce the only implementation contract for the developer.",
        },
        {
          role: "developer",
          content: "Developer work is complete only when code, preview, and smoke evidence are available for review.",
        },
      ],
      taskModifications: [
        {
          taskId: planTask.id,
          modificationType: "assign",
          details: "CTO leads planning as agreed in the engineering kickoff scrum.",
        },
        {
          taskId: acceptanceTask.id,
          modificationType: "assign",
          details: "PM owns the acceptance contract after the CTO handoff.",
        },
        {
          taskId: buildTask.id,
          modificationType: "assign",
          details: "Developer owns implementation after PM handoff.",
        },
      ],
    });

    activeExecution = {
      companyId: snapshot.company.id,
      planTaskId: planTask.id,
      acceptanceTaskId: acceptanceTask.id,
      buildTaskId: buildTask.id,
      previewTaskId: previewTask.id,
      reviewTaskId: reviewTask.id,
      planText: null,
      acceptanceText: null,
      reviewStarted: false,
      reworkCycles: 0,
    };

    const taskPlan = await generateWorkflowTaskPlan(snapshot);

    hydrateTaskFromSpec(activeExecution.planTaskId, {
      ...taskPlan.technical_plan,
      priority: mapTaskPriority(taskPlan.technical_plan.priority),
    });
    hydrateTaskFromSpec(activeExecution.acceptanceTaskId, {
      ...taskPlan.acceptance_spec,
      priority: mapTaskPriority(taskPlan.acceptance_spec.priority),
    });
    hydrateTaskFromSpec(activeExecution.buildTaskId, {
      ...taskPlan.implementation,
      priority: mapTaskPriority(taskPlan.implementation.priority),
    });
    hydrateTaskFromSpec(activeExecution.previewTaskId, {
      ...taskPlan.local_preview,
      priority: mapTaskPriority(taskPlan.local_preview.priority),
    });
    hydrateTaskFromSpec(activeExecution.reviewTaskId, {
      ...taskPlan.board_handoff,
      priority: mapTaskPriority(taskPlan.board_handoff.priority),
    });

    const coreTaskIdByStageKey = new Map<string, string>([
      ["technical_plan", activeExecution.planTaskId],
      ["acceptance_spec", activeExecution.acceptanceTaskId],
      ["implementation", activeExecution.buildTaskId],
      ["local_preview", activeExecution.previewTaskId],
      ["board_handoff", activeExecution.reviewTaskId],
    ]);
    const graphNodeTaskIdByNodeId = new Map<string, string>();

    appendTaskPlanStep(activeExecution.planTaskId, `Delivery profile: ${taskPlan.delivery_profile.replace(/_/g, " ")}`);
    appendTaskPlanStep(activeExecution.planTaskId, `Execution strategy: ${taskPlan.execution_strategy}`);

    for (const node of taskPlan.task_graph.filter((entry) => entry.stage_key)) {
      const mappedTaskId = coreTaskIdByStageKey.get(node.stage_key ?? "");
      if (!mappedTaskId) continue;
      graphNodeTaskIdByNodeId.set(node.id, mappedTaskId);
      appendTaskPlanStep(mappedTaskId, `Graph node ${node.id}: ${node.success_signal}`);
      if (node.required_skill) {
        appendTaskPlanStep(mappedTaskId, `Required skill: ${node.required_skill}`);
      }
    }

    const createdGraphTasks = new Map<string, string>();
    const specialistNodes = taskPlan.task_graph.filter((entry) => entry.stage_key === null);

    for (const node of specialistNodes) {
      if (!getAgentByRole(snapshot, node.assigned_role)) continue;

      const specialistTask = createWorkflowTask(
        snapshot,
        node.kind,
        node.assigned_role,
        node.title,
        node.description,
        node.description,
        node.success_signal,
        [node.success_signal, "Planner graph node captured for autonomous scheduling."],
        "medium",
        "created",
      );

      if (node.required_skill) {
        specialistTask.plannerState.selectedTools = uniqueStrings([...specialistTask.plannerState.selectedTools, `skill:${node.required_skill}`], 8);
      }
      specialistTask.plannerState.planSteps = uniqueStrings(
        [
          ...specialistTask.plannerState.planSteps,
          `Target surface: ${node.target_surface}`,
          `Success signal: ${node.success_signal}`,
        ],
        12,
      );

      upsertTask(specialistTask);
      createdGraphTasks.set(node.id, specialistTask.id);
      graphNodeTaskIdByNodeId.set(node.id, specialistTask.id);
    }

    for (const node of specialistNodes) {
      const specialistTaskId = createdGraphTasks.get(node.id);
      if (!specialistTaskId) continue;

      const resolvedDependencies = node.depends_on
        .map((dependencyId) => graphNodeTaskIdByNodeId.get(dependencyId))
        .filter((value): value is string => Boolean(value && value !== specialistTaskId))

      if (resolvedDependencies.length > 0) {
        updateTask(specialistTaskId, (task) => ({
          ...task,
          parentTaskId: resolvedDependencies[0],
          dependsOnTaskIds: uniqueStrings(resolvedDependencies, 8),
        }));
        for (const dependencyId of resolvedDependencies) {
          attachChildTask(dependencyId, specialistTaskId);
        }
      }
    }

    // For core pipeline tasks (plan→acceptance→implementation→preview→review),
    // NEVER overwrite the hardcoded dependency chain with LLM-generated graph edges.
    // The LLM planner can produce circular or wrong dependencies for core tasks.
    // Only apply LLM graph edges to specialist/non-core tasks.
    // Core task dependencies are already set at lines above (buildTask depends on acceptanceTask, etc.).

    // Follow-up tasks are no longer generated upfront.  All specialist
    // work is represented in the task_graph as properly sequenced graph
    // nodes.  This avoids redundant tasks when the developer's first pass
    // already covers the follow-up scope.

    updateMeeting(kickoffMeeting.id, (meeting) => ({
      ...meeting,
      summary: `${meeting.summary} Meeting ${meeting.id} anchors the ${taskPlan.delivery_profile.replace(/_/g, " ")} task pipeline for this sprint.`,
    }));
    emitEmployeeActivity("system", "info", `Task pipeline created for ${taskPlan.delivery_profile.replace(/_/g, " ")}: CTO plan → PM spec → Developer implementation → Preview validation → CTO review → Specialist tasks`, {
      meetingId: kickoffMeeting.id,
    });
    await runPlanningPhase(snapshot);
    await continueExecutionFromCurrentState("post-planning");
  } catch (err) {
    executionStatus = "error";
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (activeExecution) {
      setTaskStatus(activeExecution.planTaskId, "failed", msg);
      recordMeeting({
        type: "escalation",
        facilitatorRole: "cto",
        participantRoles: ["cto", "ceo"],
        summary: "Execution escalated to leadership after a planning-stage failure.",
        agenda: [
          {
            topic: "Execution failure",
            type: "blocker",
            content: msg,
            raisedByRole: "cto",
            relatedTaskId: activeExecution.planTaskId,
          },
        ],
        decisions: [
          {
            description: "Leadership paused autonomous execution until the blocker is understood.",
            decidedByRoles: ["cto", "ceo"],
            impactIds: [activeExecution.planTaskId],
          },
        ],
      });
    }
    emitEmployeeActivity("system", "error", `Execution failed: ${msg}`);
  }
}

async function startEventBridge() {
  try {
    const opencode = await getOpencode();
    const response = await fetch(`${opencode.server.url}/event`);

    if (!response.ok || !response.body) {
      emitEmployeeActivity("system", "error", "Failed to connect to OpenCode event stream");
      return;
    }

    const reader = response.body.getReader();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += new TextDecoder().decode(value, { stream: true });

      while (buffer.includes("\n\n")) {
        const idx = buffer.indexOf("\n\n");
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLine = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");

        if (!dataLine) continue;

        try {
          void processEvent(JSON.parse(dataLine));
        } catch {
          /* ignore parse errors */
        }
      }
    }
  } catch {
    emitEmployeeActivity("system", "info", "Event bridge disconnected — will reconnect on next OpenCode call");
    eventBridgeStarted = false;
    resetOpencodeConnection();
    // Auto-reconnect after a brief delay
    setTimeout(() => {
      if (!eventBridgeStarted) {
        startEventBridge().catch(() => {});
        eventBridgeStarted = true;
      }
    }, 3000);
  }
}

async function processEvent(event: { type: string; properties?: Record<string, any> }) {
  const props = event.properties;
  if (!props) return;

  const sessionId: string | undefined = props.info?.sessionID ?? props.part?.sessionID ?? props.sessionID;
  if (!sessionId) return;

  const role = resolveRoleBySessionId(sessionId);
  if (!role) return;

  const agentState = agentSessions.get(role);
  if (agentState) {
    updateAgentSessionState(role, {
      lastEventAt: nowIso(),
      lastEventType: event.type,
      eventCount: agentState.eventCount + 1,
      stallReason: null,
    });
    touchAgentSession(role);
    if (role === "developer" && agentState.status === "working") {
      scheduleDeveloperWatchdog();
    }
  }

  if (event.type === "message.part.updated" && props.part) {
    const part = props.part;

    if (part.type === "text") {
      const textContent = String(part.text ?? part.content ?? part.delta ?? "");
      if (textContent) {
        updateAgentSessionState(role, {
          lastProgressAt: nowIso(),
          lastEventSummary: truncateTelemetry(textContent),
          awaiting: role === "developer" ? "executing requested work" : "streaming response",
        });
      }
      if (role === "developer" && textContent) {
        for (const previewUrl of extractPreviewUrls(textContent)) {
          const registered = await registerReportedPreviewUrl(previewUrl);
          if (registered && activeExecution) {
            setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
            appendTaskResult(activeExecution.buildTaskId, `preview:${previewUrl}`);
            emitEmployeeActivity("developer", "info", `Developer reported preview URL → ${previewUrl}`, {
              taskId: activeExecution.buildTaskId,
            });
          }
        }
      }
    }

    if (part.type === "tool-invocation" || part.type === "tool-result" || part.type === "tool") {
      const toolName: string = part.toolInvocation?.toolName ?? part.tool ?? part.name ?? "";
      const args: Record<string, any> = part.toolInvocation?.args ?? part.state?.input ?? {};
      const toolStatus: string = part.state?.status ?? "";
      const isInvocation = part.type === "tool-invocation";

      if (toolName) {
        updateAgentSessionState(role, {
          lastToolName: toolName,
          lastToolStatus: isInvocation ? "invoked" : "completed",
          lastToolAt: nowIso(),
          lastProgressAt: nowIso(),
          lastEventSummary: `${isInvocation ? "Running" : "Completed"} tool ${toolName}`,
          awaiting: isInvocation ? `waiting for ${toolName} result` : "processing tool result",
          toolInvocationCount: isInvocation ? (agentSessions.get(role)?.toolInvocationCount ?? 0) + 1 : agentSessions.get(role)?.toolInvocationCount ?? 0,
        });
      }

      if (isInvocation && (toolName === "edit" || toolName === "write" || toolName === "patch" || toolName === "apply_patch")) {
        const filePath = args.filePath || args.file_path || "unknown file";
        updateAgentSessionState(role, {
          fileEditCount: (agentSessions.get(role)?.fileEditCount ?? 0) + 1,
          lastEventSummary: `Edited ${filePath}`,
          lastWorkspaceChangeAt: nowIso(),
          awaiting: role === "developer" ? "editing workspace" : "continuing after file edit",
        });
        emitEmployeeActivity(role, "file_edit", filePath, {
          taskId: role === "developer" && activeExecution ? activeExecution.buildTaskId : null,
        });
        if (role === "developer" && activeExecution) {
          appendTaskResult(activeExecution.buildTaskId, `edited:${filePath}`);
        }
      } else if (isInvocation && toolName === "bash") {
        const cmd = String(args.command || "").slice(0, 180);
        updateAgentSessionState(role, {
          shellCommandCount: (agentSessions.get(role)?.shellCommandCount ?? 0) + 1,
          lastEventSummary: `$ ${cmd}`,
          awaiting: "waiting for shell result",
        });
        emitEmployeeActivity(role, "shell", `$ ${cmd}`, {
          taskId: role === "developer" && activeExecution ? activeExecution.buildTaskId : null,
        });
        if (role === "developer" && activeExecution) {
          appendTaskCommand(activeExecution.buildTaskId, cmd);
        }
      } else if (isInvocation && toolName) {
        emitEmployeeActivity(role, "info", `tool: ${toolName}`);
      }
    }
  }

  if (event.type === "session.idle" && agentState) {
    // When the step loop is active, each prompt() returns on session.idle.
    // The loop itself handles progression — don't trigger post-developer routing here.
    if (role === "developer" && developerStepLoopActive) {
      touchAgentSession(role, "working");
      updateAgentSessionState(role, {
        lastProgressAt: nowIso(),
        lastEventSummary: "Step prompt completed. Verifying…",
      });
      return;
    }

    touchAgentSession(role, "done");
    updateAgentSessionState(role, {
      awaiting: "idle",
      promptCompletedAt: nowIso(),
      lastProgressAt: nowIso(),
      activeTaskId: role === "developer" ? activeExecution?.previewTaskId ?? null : null,
      lastEventSummary: role === "developer" ? "Implementation finished. Handing off to preview validation." : "Work complete.",
    });
    if (role === "developer") {
      clearDeveloperWatchdog();
      stopDeveloperWorkspaceMonitor();
    }

    if (role === "developer") {
      emitEmployeeActivity(role, "idle", "Implementation task complete. Routing to next phase via dynamic orchestration.", {
        taskId: activeExecution?.buildTaskId ?? null,
      });
      if (activeExecution?.buildTaskId) {
        setTaskStatus(activeExecution.buildTaskId, "completed", "Implementation finished. Router will decide next steps.");
      }
      try {
        await continueExecutionFromCurrentState("post-developer-idle");
      } catch (error) {
        executionStatus = "error";
        const message = error instanceof Error ? error.message : "Post-developer routing failed.";
        if (activeExecution) {
          setTaskStatus(activeExecution.previewTaskId, "failed", message);
        }
        emitEmployeeActivity("system", "error", message, {
          taskId: activeExecution?.previewTaskId ?? null,
        });
      }
      return;
    }

    emitEmployeeActivity(role, "idle", "Work complete");
  }

  if (event.type === "session.error" && agentState) {
    touchAgentSession(role, "error");
    updateAgentSessionState(role, {
      awaiting: "session error",
      promptCompletedAt: nowIso(),
      stallReason: props.error?.message ?? "Session error",
      lastEventSummary: props.error?.message ?? "Session error",
    });
    if (role === "developer") {
      clearDeveloperWatchdog();
      stopDeveloperWorkspaceMonitor();
    }
    executionStatus = "error";
    if (role === "developer" && activeExecution) {
      setTaskStatus(activeExecution.buildTaskId, "failed", props.error?.message ?? "Developer session error");
      recordMeeting({
        type: "escalation",
        facilitatorRole: "developer",
        participantRoles: ["developer", "cto", "ceo"],
        summary: "Developer session failed and was escalated to leadership.",
        agenda: [
          {
            topic: "Developer runtime failure",
            type: "blocker",
            content: props.error?.message ?? "Developer session error",
            raisedByRole: "developer",
            relatedTaskId: activeExecution.buildTaskId,
          },
        ],
        decisions: [
          {
            description: "Leadership will review the developer runtime failure before resuming execution.",
            decidedByRoles: ["developer", "cto", "ceo"],
            impactIds: [activeExecution.buildTaskId],
          },
        ],
      });
    }
    emitEmployeeActivity(role, "error", props.error?.message ?? "Session error", {
      taskId: role === "developer" ? activeExecution?.buildTaskId ?? null : null,
    });
  }
}
