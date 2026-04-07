import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { getOpencode, postOpencodeJson } from "./opencode";
import { getRoleSoul } from "@arceus/company-runtime";
import { ensureDeployment, orchestratorConfig } from "./config/index";
import { emitEmployeeActivity } from "./activity";
import { getSnapshot, replaceTasks, updateAgentMemory, updateApproval, updateMeeting, updateTask, upsertApproval, upsertMeeting, upsertTask } from "./store";
import type { Approval, CompanySnapshot, AgentIdentity, Meeting, Task, Transition, TransitionProposal } from "@arceus/contracts";
import type { CeoCard } from "./ceo";
import { clearReportedPreviewCandidate, getLocalPreviewState, hasLocalPreviewCandidate, hasReportedPreviewCandidate, registerReportedPreviewUrl, startLocalPreview, stopLocalPreview } from "./preview";
import { generateWorkflowTaskPlan, mapTaskPriority } from "./task-planner";
import { runRouterLoop, type RouterLoopResult } from "./router";
import { persistRuntimeArtifact } from "./artifact-persistence";
import { workspaceManager } from "./workspace-manager";

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
const workspaceRoot = resolve(process.cwd(), "..", "..");
const productDir = resolve(workspaceRoot, "workspace");
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

  await maybeStartDeveloperLivePreview(changedFiles);
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

  if (isUntrustedStaticFallbackPreview(preview)) {
    emitEmployeeActivity("developer", "info", "Static fallback preview is not accepted as live evidence. Waiting for a developer-reported PREVIEW_URL.", {
      taskId: activeExecution.buildTaskId,
    });
    await stopLocalPreview();
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

async function tagCurrentSprintSnapshot() {
  const snapshot = getSnapshot();
  if (snapshot.company.id === "company_pending") {
    return;
  }

  try {
    const result = await workspaceManager.tagSprint(snapshot.company.id, Math.max(1, snapshot.sprints.length || 1), snapshot);
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

function isUntrustedStaticFallbackPreview(preview: ReturnType<typeof getLocalPreviewState>) {
  return preview.framework === "Static HTML" && !hasReportedPreviewCandidate();
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
): Task {
  const agent = getAgentByRole(snapshot, role);

  return {
    id: `task_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
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

function determineFollowUpParentTaskId(title: string, description: string, context: ExecutionContext) {
  const text = `${title} ${description}`.toLowerCase();

  if (/(preview|smoke|launch|serve|run locally|reachable)/.test(text)) {
    return context.previewTaskId;
  }

  if (/(review|handoff|board|verify verdict)/.test(text)) {
    return context.reviewTaskId;
  }

  if (/(acceptance|criteria|scope|non-goal|definition of done)/.test(text)) {
    return context.acceptanceTaskId;
  }

  return context.buildTaskId;
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

  const blockedOrFailedTasks = snapshot.tasks.filter((task) => ["blocked", "failed"].includes(task.status));
  if (blockedOrFailedTasks.length > 0) {
    return {
      shouldPause: true,
      reason: `Board review required because ${blockedOrFailedTasks.length} task${blockedOrFailedTasks.length === 1 ? " is" : "s are"} blocked or failed.`,
    };
  }

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

function completeExecutionCycle(reason: string) {
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
  await runAutonomousReadyTasks("post-review");

  const snapshot = getSnapshot();
  const boardDecision = shouldPauseForBoardReview(snapshot);
  if (boardDecision.shouldPause) {
    pauseForBoardReview(boardDecision.reason ?? "Board review required.");
    return;
  }

  completeExecutionCycle("Autonomous execution completed without requiring additional board review.");
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
    // The async work (developer session) will eventually fire events that re-enter this function
    const snapshot = getSnapshot();
    const buildTask = getTaskById(activeExecution.buildTaskId, snapshot);
    if (buildTask && buildTask.status === "in_progress" && buildTask.kind === "implementation") {
      await startDeveloperPhase(snapshot);
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

  // Check if execution is complete
  const finalSnapshot = getSnapshot();
  const allDone = finalSnapshot.tasks.every((t) =>
    ["completed", "cancelled", "failed"].includes(t.status)
  );
  if (allDone) {
    completeExecutionCycle("All tasks completed via dynamic routing.");
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
        // Developer phase is async — handled via yield in shouldYield
        break;

      case "local_preview":
        if (transition.toStatus === "in_progress" || transition.toStatus === "verifying") {
          await startPreviewPhase();
        }
        break;

      case "board_handoff":
        if (transition.toStatus === "in_progress") {
          await startReviewPhase();
        }
        break;

      default:
        // Specialist tasks (tester, ui_designer, marketing, skills_lead, etc.)
        if (transition.toStatus === "in_progress" && isTaskReadyForAutonomousExecution(task, snapshot)) {
          await executeSpecialistTask(task.id);
        }
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Phase execution failed";
    console.error(`[Router] executeTransitionWork failed for ${task.id} (${task.kind}):`, message);
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

async function runPromptText(role: AgentIdentity["role"], sessionId: string, systemPrompt: string, text: string) {
  const deployment = ensureDeployment("workerDeployment");
  const opencode = await getOpencode();
  updateAgentSessionState(role, {
    promptStartedAt: nowIso(),
    promptCompletedAt: null,
    awaiting: "waiting for Opencode response",
    lastEventSummary: truncateTelemetry(text, 140),
    stallReason: null,
  });
  const result = await opencode.client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID: "azure", modelID: deployment },
      agent: role,
      system: systemPrompt,
      parts: [{ type: "text", text }],
    },
  });

  const output = (
    (result.data?.parts as Array<{ type: string; text?: string }>)
      ?.filter((part) => part.type === "text" && part.text)
      .map((part) => part.text ?? "")
      .join("\n")
      .trim() || ""
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

  const ctoPlan = await runPromptText(
    "cto",
    ctoSession.sessionId,
    ctoSoul.systemPrompt,
    [
      `# Strategy: ${snapshot.strategy.title}`,
      "",
      `## Summary`,
      snapshot.strategy.summary,
      "",
      `## First Release`,
      snapshot.strategy.firstRelease,
      "",
      `## Scope Boundaries`,
      ...snapshot.strategy.scopeBoundary.map((item) => `- ${item}`),
      "",
      `## Workspace Context`,
      `You have access to the full workspace rooted at ${workspaceRoot}.`,
      `Read any relevant documents or existing code under ${productDir} before finalising your plan.`,
      `This should be a spec-driven development plan that a PM can convert into acceptance criteria and a developer can execute.`,
      "",
      `## Output Requirements`,
      `Produce text only. Include architecture, file structure, implementation sequence, and explicit verification points.`,
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
    awaiting: "waiting for first Opencode response",
    lastEventSummary: "Developer prompt submitted to Opencode.",
    stallReason: null,
  });
  updateRoleMemory("developer", ["Implement approved spec", `Company workspace: ${productDir}`, `Read docs/files under ${productDir} before editing`]);
  setTaskStatus(activeExecution.buildTaskId, "in_progress");
  emitEmployeeActivity("developer", "working", "Implementing the delivery spec in the company workspace…", { taskId: activeExecution.buildTaskId });

  await postOpencodeJson(`/session/${devSession.sessionId}/prompt_async`, {
    model: { providerID: "azure", modelID: ensureDeployment("workerDeployment") },
    agent: "developer",
    system: devSoul.systemPrompt,
    parts: [
      {
        type: "text",
        text: [
          `# Workspace Context`,
          `The full workspace root is ${workspaceRoot}.`,
          `All implementation output must go in ${productDir}.`,
          `Read any existing docs and code under ${productDir} before changing files.`,
          "",
          `# CTO Technical Plan`,
          activeExecution.planText,
          "",
          `# PM Acceptance Criteria`,
          activeExecution.acceptanceText,
          "",
          `# Delivery Rules`,
          `1. Work only through the company workspace at ${productDir}.`,
          `2. If the workspace is empty, scaffold it there.`,
          `3. Get a minimal runnable app and local preview working as early as possible, then iterate on top of that instead of waiting until the end.`,
          `4. Add or preserve the scripts and files needed so the preview detector can launch the app locally.`,
          `4a. When you discover a working preview or service endpoint, print a line exactly like PREVIEW_URL: http://127.0.0.1:3000/path so the runtime can validate and surface it immediately.`,
          `5. Run the minimum validation needed to prove the result works.`,
          `6. Stop when the implementation is ready for CTO review. Do not continue with extra polish after the spec is satisfied.`,
          `7. Keep your work legible for board review.`,
        ].join("\n"),
      },
    ],
  });

  emitEmployeeActivity("developer", "info", `Target workspace: ${productDir}`, { taskId: activeExecution.buildTaskId });
  await startDeveloperWorkspaceMonitor();
  scheduleDeveloperWatchdog();
}

async function startPreviewPhase() {
  if (!activeExecution) return;

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
    setTaskStatus(activeExecution.previewTaskId, "failed", preview.lastError ?? "Preview launch failed.");
    recordMeeting({
      type: "escalation",
      facilitatorRole: "developer",
      participantRoles: ["developer", "cto", "ceo"],
      summary: "Developer escalated a preview launch failure to engineering leadership.",
      agenda: [
        {
          topic: "Preview launch blocker",
          type: "blocker",
          content: preview.lastError ?? "Local preview launch failed.",
          raisedByRole: "developer",
          relatedTaskId: activeExecution.previewTaskId,
        },
      ],
      decisions: [
        {
          description: "CTO reviews the preview failure before any additional implementation work proceeds.",
          decidedByRoles: ["developer", "cto", "ceo"],
          impactIds: [activeExecution.previewTaskId],
        },
      ],
      taskModifications: [
        {
          taskId: activeExecution.previewTaskId,
          modificationType: "unblock",
          details: "Preview failed and requires CTO escalation review.",
        },
      ],
    });
    throw new Error(preview.lastError ?? "Preview launch failed.");
  }

  if (isUntrustedStaticFallbackPreview(preview)) {
    await stopLocalPreview();
    const message = "Preview fallback resolved to a static index page without a developer-reported PREVIEW_URL. The developer must report the real preview endpoint before preview can pass.";
    setTaskStatus(activeExecution.previewTaskId, "failed", message);
    throw new Error(message);
  }

  setTaskPreviewUrl(activeExecution.previewTaskId, previewUrl);
  appendTaskResult(activeExecution.previewTaskId, `preview:${previewUrl}`);
  await syncWorkspaceCheckpoint(
    activeExecution.buildTaskId,
    "developer",
    `Developer implementation reached a runnable preview at ${previewUrl}`
  );
  setTaskStatus(activeExecution.previewTaskId, "completed", `Local preview reachable at ${previewUrl}`);
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
}

async function startReviewPhase() {
  if (!activeExecution || activeExecution.reviewStarted || !activeExecution.planText || !activeExecution.acceptanceText) {
    return;
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
      `1. Review verdict`,
      `2. What was built`,
      `3. Verification evidence`,
      `4. Open risks or follow-ups`,
      `5. Recommendation to the board`,
      "",
      `If unresolved risks or blocked work remain, state clearly that board review is recommended. If the remaining work is autonomous and policy-safe, say so explicitly.`,
    ].join("\n"),
  );

  ctoSession.status = "idle";
  const reviewArtifact = addArtifact("cto", "output", "Board Handoff Review", reviewText || "CTO review completed without summary text.");
  appendTaskResult(activeExecution.reviewTaskId, `artifact:${reviewArtifact.id}`);
  attachArtifactToTask(activeExecution.reviewTaskId, reviewArtifact.id);
  setTaskPreviewUrl(activeExecution.reviewTaskId, getLocalPreviewState().url);
  setTaskStatus(activeExecution.buildTaskId, "completed", "Implementation finished and ready for board review.");
  setTaskStatus(activeExecution.reviewTaskId, "completed", "Board handoff prepared.");
  const boardPrepMeeting = recordMeeting({
    type: "handoff",
    facilitatorRole: "cto",
    participantRoles: ["cto", "ceo"],
    summary: "CTO and CEO aligned on the review packet and decided whether more autonomous execution is needed.",
    agenda: [
      {
        topic: "Implementation review verdict",
        type: "update",
        content: "CTO summarized what was built, verification evidence, and open risks for board review.",
        raisedByRole: "cto",
        relatedTaskId: activeExecution.reviewTaskId,
      },
      {
        topic: "Autonomy checkpoint",
        type: "proposal",
        content: "CEO will either continue autonomous execution on ready dependent work or escalate to the board only if policy requires it.",
        raisedByRole: "ceo",
        relatedTaskId: activeExecution.reviewTaskId,
      },
    ],
    decisions: [
      {
        description: "Board review is used only when unresolved risk, blocked work, or approvals require explicit intervention.",
        decidedByRoles: ["cto", "ceo"],
        impactIds: [activeExecution.reviewTaskId, reviewArtifact.id],
      },
    ],
    learnings: [
      {
        role: "ceo",
        content: "Board review now depends on the CTO handoff artifact and attached preview evidence.",
      },
    ],
  });
  emitEmployeeActivity("cto", "idle", `Board handoff ready → /api/artifacts/${reviewArtifact.id}`, {
    taskId: activeExecution.reviewTaskId,
    meetingId: boardPrepMeeting.id,
  });
  await reconcilePostReviewExecution();
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

  await tagCurrentSprintSnapshot();

  return {
    executionStatus,
    reviewTaskId,
    queuedFollowUpCount,
    resolvedApprovalCount: resolvedApprovals.length,
  };
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
  emitEmployeeActivity("system", "info", "Beginning strategy execution…");

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

    for (const node of taskPlan.task_graph.filter((entry) => entry.stage_key)) {
      const mappedTaskId = graphNodeTaskIdByNodeId.get(node.id);
      if (!mappedTaskId) continue;

      const resolvedDependencies = node.depends_on
        .map((dependencyId) => graphNodeTaskIdByNodeId.get(dependencyId))
        .filter((value): value is string => Boolean(value && value !== mappedTaskId));

      if (resolvedDependencies.length === 0) {
        continue;
      }

      updateTask(mappedTaskId, (task) => ({
        ...task,
        parentTaskId: resolvedDependencies[0] ?? task.parentTaskId,
        dependsOnTaskIds: uniqueStrings(resolvedDependencies, 8),
      }));

      for (const dependencyId of resolvedDependencies) {
        attachChildTask(dependencyId, mappedTaskId);
      }
    }

    for (const followUp of taskPlan.follow_up_tasks) {
      if (!getAgentByRole(snapshot, followUp.assigned_role)) continue;

      const parentTaskId = determineFollowUpParentTaskId(followUp.title, followUp.description, activeExecution);
      const followUpTask = createWorkflowTask(
        snapshot,
        "follow_up",
        followUp.assigned_role,
        followUp.title,
        followUp.description,
        followUp.problem_statement,
        followUp.deliverable,
        followUp.definition_of_done,
        mapTaskPriority(followUp.priority),
        "created",
      );

      followUpTask.parentTaskId = parentTaskId;
      followUpTask.dependsOnTaskIds = [parentTaskId];
      upsertTask(followUpTask);
      attachChildTask(parentTaskId, followUpTask.id);
    }

    updateMeeting(kickoffMeeting.id, (meeting) => ({
      ...meeting,
      summary: `${meeting.summary} Meeting ${meeting.id} anchors the ${taskPlan.delivery_profile.replace(/_/g, " ")} task pipeline for this sprint.`,
    }));
    emitEmployeeActivity("system", "info", `Task pipeline created for ${taskPlan.delivery_profile.replace(/_/g, " ")}: CTO plan → PM spec → Developer implementation → Local validation → CTO board handoff review`, {
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
    emitEmployeeActivity("system", "info", "Event bridge disconnected");
    eventBridgeStarted = false;
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

    if (part.type === "tool-invocation" || part.type === "tool-result") {
      const toolName: string = part.toolInvocation?.toolName ?? part.name ?? "";
      const args: Record<string, any> = part.toolInvocation?.args ?? {};
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

      if (toolName === "edit" || toolName === "write" || toolName === "patch") {
        const filePath = args.file_path || args.filePath || "file";
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
      } else if (toolName === "bash") {
        const cmd = String(args.command || "").slice(0, 180);
        updateAgentSessionState(role, {
          shellCommandCount: (agentSessions.get(role)?.shellCommandCount ?? 0) + 1,
          lastEventSummary: `$ ${cmd}`,
          awaiting: isInvocation ? "waiting for shell result" : "processing shell result",
        });
        emitEmployeeActivity(role, "shell", `$ ${cmd}`, {
          taskId: role === "developer" && activeExecution ? activeExecution.buildTaskId : null,
        });
        if (role === "developer" && activeExecution) {
          appendTaskCommand(activeExecution.buildTaskId, cmd);
        }
      } else if (toolName) {
        emitEmployeeActivity(role, "info", `tool: ${toolName}`);
      }
    }
  }

  if (event.type === "session.idle" && agentState) {
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
