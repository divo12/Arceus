import { mkdir, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { getOpencode, resetOpencodeConnection, createBeatSession, destroyBeatSession } from "./opencode";
import { getRoleSoul, filterToolsForAgent, toOpenCodeToolsParam, summarizeFilterResult, BASE_POLICY_RULES, buildTrustEvent, getTrustTier, evaluatePolicy, TRUST_CONFIG, getAgentSkills, seedExistingSkills, isSkillRegistrySeeded, matchSkills as registryMatchSkills, getSkillsForRole as registryGetSkillsForRole, recordSkillUsage, getAllSkills, getSkillHealth, getSkillHistory as registryGetSkillHistory, getSkillById, processTaskOutcome, getMutationsForCompany, runATAPipeline } from "@arceus/company-runtime";
import { initSkillEvolution } from "./skill-evolution";
import type { PolicyRule, PolicyEvalContext, PolicyDecision } from "@arceus/contracts";
import { ensureDeployment, orchestratorConfig, previewConfig } from "./config/index";
import { emitEmployeeActivity } from "./activity";
import { audit, auditAgent, auditSystem, auditError } from "./audit-ledger";
import { appendChatMessage, getSnapshot, replaceTasks, updateAgentMemory, updateApproval, updateCompanySprint, updateMeeting, updateSprint, updateTask, upsertApproval, upsertMeeting, upsertSprint, upsertTask } from "./store";
import type { Approval, CompanySnapshot, AgentIdentity, Meeting, Sprint, SprintReviewState, Task, Transition, TransitionProposal } from "@arceus/contracts";
import type { CeoCard } from "./ceo";
import { buildCeoOperatingPrompt, classifyCeoResponse } from "./ceo";
import { isCeoStreaming } from "./chat";
import { clearReportedPreviewCandidate, getLocalPreviewState, hasLocalPreviewCandidate, hasReportedPreviewCandidate, probePreviewHealth, registerReportedPreviewUrl, startLocalPreview, stopLocalPreview } from "./preview";
import { generateWorkflowTaskPlan, mapTaskPriority } from "./task-planner";
import { persistRuntimeArtifact } from "./artifact-persistence";
import { describePgError } from "./pg-errors";
import { workspaceManager } from "./workspace-manager";
import { structuredCompletion, startBeatTokenAccumulator, drainBeatTokenAccumulator } from "./azure-openai";
import { cpCommitTaskResult, cpLoadTrustScore, cpUpdateTrustScore, cpRecordPolicyViolation } from "./control-plane";
import { withRetry, isRetryableError } from "./resilience";
import { createHippocampusService, EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, ACTION_DECISION_SYSTEM_PROMPT, buildActionDecisionUserPrompt, HABIT_MATCHER_SYSTEM_PROMPT, buildHabitMatcherUserPrompt, PRIMING_GENERATOR_SYSTEM_PROMPT, buildPrimingGeneratorUserPrompt, createPgVectorStores } from "@arceus/hippocampus";
import type { PreparedAgentContext, ExtractedFact, MemoryAction } from "@arceus/hippocampus";
import type { BeatEventTrigger } from "@arceus/contracts";
import { z } from "zod";

import {
  createReviewState,
  buildGateFailureBugFields,
  buildBugFixTaskFields,
  parseQAReport,
  routeDefect,
  allBugFixesResolved,
  shouldRetestAfterRework,
  shouldEscalate,
  type QAReport,
  type QAFinding,
} from "./sprint-review";
import { runVerificationGate } from "./verification-gate";
import { scaffoldProductWorkspace, STYLE_GUIDE_MD } from "./workspace-scaffold";

// ---------------------------------------------------------------------------
// Reactive event emitter — wired to HeartbeatEngine.emitEvent() by server.ts
// ---------------------------------------------------------------------------

let reactiveEventEmitter: ((companyId: string, agentId: string, role: AgentIdentity["role"], event: BeatEventTrigger) => void) | null = null;

/** Called by server.ts after HeartbeatEngine is created. */
export function setReactiveEventEmitter(fn: typeof reactiveEventEmitter) {
  reactiveEventEmitter = fn;
}

/** Emit a reactive event for a specific role (resolves agentId from snapshot). */
function emitReactive(role: AgentIdentity["role"], event: BeatEventTrigger) {
  if (!reactiveEventEmitter) return;
  const snapshot = getSnapshot();
  const agent = getAgentByRole(snapshot, role);
  if (!agent) return;
  reactiveEventEmitter(snapshot.company.id, agent.id, role, event);
}

/** Emit a reactive event to ALL agents (used for broadcast events like sprint_started). */
function emitReactiveBroadcast(event: BeatEventTrigger) {
  if (!reactiveEventEmitter) return;
  const snapshot = getSnapshot();
  for (const agent of snapshot.agents) {
    reactiveEventEmitter(snapshot.company.id, agent.id, agent.role, event);
  }
}

// ---------------------------------------------------------------------------
// Hippocampus — singleton memory service (in-memory stores for now)
// ---------------------------------------------------------------------------

/** Sanitize tool arguments for audit logging — scrub potential secrets. */
function sanitizeToolArgs(args: Record<string, any>): Record<string, unknown> {
  const SECRET_KEYS = /key|secret|token|password|auth|credential|api.?key/i;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_KEYS.test(k)) {
      result[k] = "[REDACTED]";
    } else if (typeof v === "string" && v.length > 500) {
      result[k] = v.slice(0, 500) + `…[${v.length} chars]`;
    } else {
      result[k] = v;
    }
  }
  return result;
}

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

// ── Skill Registry + Evolution integration (Spec 14) ─────

// Wire LLM deps for Phase 2 failure attribution + skill mutation
initSkillEvolution();

/**
 * Ensure skills are seeded from Markdown files on first use.
 * Idempotent — no-op if already seeded.
 */
function ensureSkillsSeeded(): void {
  if (isSkillRegistrySeeded()) return;
  const snapshot = getSnapshot();
  const companyId = snapshot.company.id;
  if (!companyId || companyId === "company_empty") return;
  const count = seedExistingSkills(companyId);
  if (count > 0) {
    console.log(`[SkillRegistry] Seeded ${count} skills for company ${companyId}`);
  }
}

function buildSkillMenu(role: string): string {
  ensureSkillsSeeded();
  const snapshot = getSnapshot();
  const skills = registryGetSkillsForRole(snapshot.company.id, role);
  if (skills.length === 0) return "";
  const lines = ["", "# Available skills for this role"];
  for (const skill of skills) {
    lines.push(`- **${skill.name}** (v${skill.version}, success: ${Math.round(skill.successRate * 100)}%): ${skill.trigger}`);
  }
  return lines.join("\n");
}

function getSkillBody(role: string, skillName?: string): string {
  ensureSkillsSeeded();
  const snapshot = getSnapshot();
  const skills = registryGetSkillsForRole(snapshot.company.id, role);
  if (skills.length === 0) return "";
  if (skillName) {
    const match = skills.find(s => s.name === skillName);
    return match ? `\n# Skill: ${match.name}\n\n${match.content}` : "";
  }
  return skills.map(s => `\n# Skill: ${s.name} (v${s.version})\n\n${s.content}`).join("\n");
}

/**
 * Match and record usage of skills relevant to a task.
 * Returns matched skill IDs for later success rate updates.
 */
function matchAndRecordSkills(role: string, taskDescription: string): string[] {
  ensureSkillsSeeded();
  const snapshot = getSnapshot();
  const matched = registryMatchSkills(snapshot.company.id, role, taskDescription);
  for (const skill of matched) {
    recordSkillUsage(skill.id);
  }
  return matched.map(s => s.id);
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
  kind: "plan" | "code" | "output" | "specification";
  title: string;
  content: string;
  createdAt: string;
};

type ExecutionStatus = "idle" | "planning" | "executing" | "verifying" | "awaiting_board_review" | "paused" | "done" | "error";

type ExecutionContext = {
  companyId: string;
  buildTaskId: string;
  previewTaskId: string;
  reviewTaskId: string;
};

const CORE_EXECUTION_TASK_KINDS = new Set<Task["kind"]>(orchestratorConfig.coreExecutionTaskKinds);
const AUTONOMOUS_READY_TASK_ROLES = new Set<AgentIdentity["role"]>(orchestratorConfig.autonomousReadyTaskRoles);

const agentSessions = new Map<string, AgentSessionState>();
const artifacts: Artifact[] = [];
let executionStatus: ExecutionStatus = "idle";
let eventBridgeStarted = false;

// ── Prompt completion waiters ───────────────────────────────
// OpenCode's session.prompt() fires the message and returns immediately (empty 200).
// The actual LLM response streams back via SSE events and completes with "session.idle".
// This map allows runPromptText() to await completion by registering a promise that
// the event bridge resolves when session.idle (or session.error) fires for the session.
const pendingPromptCompletions = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

function registerPromptCompletion(sessionId: string, timeoutMs = 5 * 60 * 1000): Promise<void> {
  // Clean up any stale entry
  const existing = pendingPromptCompletions.get(sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    pendingPromptCompletions.delete(sessionId);
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPromptCompletions.delete(sessionId);
      reject(new Error(`OpenCode prompt timed out after ${timeoutMs}ms for session ${sessionId}`));
    }, timeoutMs);
    pendingPromptCompletions.set(sessionId, { resolve, reject, timer });
    // Ensure the polling fallback is running whenever there are pending completions
    startPromptCompletionPoller();
  });
}

function resolvePromptCompletion(sessionId: string) {
  const entry = pendingPromptCompletions.get(sessionId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingPromptCompletions.delete(sessionId);
    entry.resolve();
  }
}

function rejectPromptCompletion(sessionId: string, error: Error) {
  const entry = pendingPromptCompletions.get(sessionId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingPromptCompletions.delete(sessionId);
    entry.reject(error);
  }
}

// ── Polling fallback for SSE event bridge gaps ──────────────
// The SSE event bridge can drop connections under load, losing session.idle
// events forever. This sweep polls the OpenCode session status API for any
// sessions with pending completions, resolving them if the session is idle.
let promptCompletionPollerHandle: NodeJS.Timeout | null = null;
const PROMPT_COMPLETION_POLL_INTERVAL_MS = 8_000; // 8s

function startPromptCompletionPoller() {
  if (promptCompletionPollerHandle) return;
  promptCompletionPollerHandle = setInterval(() => {
    void pollPendingPromptCompletions();
  }, PROMPT_COMPLETION_POLL_INTERVAL_MS);
}

function stopPromptCompletionPoller() {
  if (promptCompletionPollerHandle) {
    clearInterval(promptCompletionPollerHandle);
    promptCompletionPollerHandle = null;
  }
}

async function pollPendingPromptCompletions() {
  if (pendingPromptCompletions.size === 0) return;

  try {
    const opencode = await getOpencode();
    const statusResult = await opencode.client.session.status({});
    const statusMap = statusResult.data as Record<string, { type: string }> | undefined;
    if (!statusMap) return;

    for (const [sessionId, _entry] of pendingPromptCompletions) {
      const sessionStatus = statusMap[sessionId];
      if (sessionStatus && sessionStatus.type === "idle") {
        emitEmployeeActivity("system", "info", `Polling fallback: session ${sessionId.slice(0, 12)}… is idle — resolving completion`);
        resolvePromptCompletion(sessionId);
      } else if (!sessionStatus) {
        // Session not in status map — it completed and was cleaned up, or never
        // started processing. Check if it has an assistant response to confirm.
        try {
          const messagesResult = await opencode.client.session.messages({ path: { id: sessionId } });
          const messages = messagesResult.data as Array<{ info: any }> | undefined;
          const hasAssistant = messages?.some((m) => m.info?.role === "assistant");
          if (hasAssistant) {
            emitEmployeeActivity("system", "info", `Polling fallback: session ${sessionId.slice(0, 12)}… not in status but has assistant response — resolving`);
            resolvePromptCompletion(sessionId);
          }
        } catch {
          // Session may have been fully GC'd — resolve anyway to avoid 5-min timeout
          emitEmployeeActivity("system", "info", `Polling fallback: session ${sessionId.slice(0, 12)}… unreachable — resolving to avoid stall`);
          resolvePromptCompletion(sessionId);
        }
      }
    }
  } catch {
    // Non-fatal — SSE bridge is the primary path; polling is best-effort
  }
}

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

/**
 * Try to auto-start preview after a developer beat completes.
 * Fire-and-forget — never blocks or crashes the beat path.
 */
async function tryAutoPreview() {
  const previewState = getLocalPreviewState();
  // Already running — nothing to do
  if (previewState.status === "starting" || previewState.status === "ready") {
    emitEmployeeActivity("system", "preview", `Auto-preview skipped — already ${previewState.status}`);
    return;
  }

  // Check if workspace has something runnable
  const hasCandidate = hasReportedPreviewCandidate() || await hasLocalPreviewCandidate(productDir);
  if (!hasCandidate) {
    emitEmployeeActivity("system", "preview", "Auto-preview skipped — no runnable project found in workspace/");
    return;
  }

  emitEmployeeActivity("system", "preview", "Auto-starting preview after developer beat…");
  const preview = await startLocalPreview(productDir);
  const previewUrl = preview.validationUrl ?? preview.entryUrl ?? preview.url;
  if (preview.status === "ready" && previewUrl) {
    emitEmployeeActivity("system", "preview", `Preview auto-started → ${previewUrl}`, { detail: { url: previewUrl, status: preview.status } });
  } else {
    emitEmployeeActivity("system", "error", `Auto-preview failed: ${preview.lastError ?? "did not become reachable"}`, { detail: { status: preview.status, lastError: preview.lastError } });
  }
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

  // Reactive: wake all agents — a new sprint has started
  emitReactiveBroadcast("sprint_started");

  return sprint;
}

/**
 * After a sprint completes, triggers the CEO to auto-propose Sprint N+1 via LLM.
 * If auto-approve is enabled and this isn't a board-review sprint, the proposal is
 * approved immediately without waiting for the board.
 *
 * Concurrency: guarded by `ceoProposalInFlight`. `triggerCeoSprintProposal` can be
 * invoked from three paths (finalizeSprintCompletion, the CEO heartbeat beat's
 * all-terminal detector, and the CEO checklist action), and all three can fire
 * within the same beat window once a sprint becomes `completed`. Without the
 * in-flight lock, two racers both pass the wait-gate and the duplicate-guard
 * (the chat message isn't appended until after the LLM returns), both pay for a
 * CEO LLM call, and the second caller's `approveSprintProposal` throws with
 * "execution is 'executing'" because the first caller has already started
 * Sprint N+1 via `beginSprintExecution`. The lock drops the loser cheaply with
 * an info log — a second proposal for the same sprint is always redundant.
 */
let ceoProposalInFlight = false;

async function triggerCeoSprintProposal(): Promise<void> {
  if (ceoProposalInFlight) {
    emitEmployeeActivity(
      "ceo",
      "info",
      "CEO proposal already in flight — skipping duplicate trigger.",
    );
    return;
  }
  ceoProposalInFlight = true;
  try {
    // Ensure the current sprint is marked complete before proposing a new one
    await checkSprintCompletion();

    const snapshot = getSnapshot();

    // Wait gate: don't propose a new sprint while the current one is still in-flight
    // (planned / executing / reviewing). Emits info (not error) so the inbox stays
    // clean, and skips the LLM call that would otherwise be rejected at the
    // approveSprintProposal gate. CEO beat will retry once the sprint closes.
    const inFlightSprint = snapshot.company.currentSprintId
      ? snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId)
      : null;
    if (inFlightSprint && inFlightSprint.status !== "completed") {
      emitEmployeeActivity(
        "ceo",
        "info",
        `CEO waiting — Sprint ${inFlightSprint.number} is "${inFlightSprint.status}". Next proposal will fire once it closes.`,
      );
      return;
    }

    // Duplicate guard: if a sprint_proposal card already exists for the current sprint,
    // try to auto-approve it instead of generating a new one.
    const existingProposal = snapshot.chatMessages.find(
      (m) => m.cardType === "sprint_proposal" && m.sprintId === snapshot.company.currentSprintId,
    );
    if (existingProposal) {
      const card = existingProposal.cardData as CeoCard | null;
      if (card?.sprint_proposal && orchestratorConfig.sprint.autoApproveProposals) {
        const nextSprintNumber = (snapshot.company.currentSprintNumber ?? 0) + 1;
        const cadence = orchestratorConfig.sprint.boardReviewEveryNSprints;
        const needsBoardReview = cadence > 0 && nextSprintNumber % cadence === 0;
        if (!needsBoardReview) {
          executionStatus = "done";
          emitEmployeeActivity("ceo", "info", `Re-approving existing Sprint ${nextSprintNumber} proposal.`);
          await approveSprintProposal(card);
        }
      }
      return;
    }

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
  } finally {
    // Always clear the in-flight flag — even on throw — so a crashed proposal
    // can't deadlock the next sprint cycle.
    ceoProposalInFlight = false;
  }
}

let sprintCompletionTriggered = false;

/**
 * Checks if all employee tasks in the current sprint have reached terminal status.
 * If so, enters the "reviewing" phase (Spec 21) instead of immediately completing.
 * The reviewing phase runs a pre-gate build check, then hands off to the tester
 * via the heartbeat checklist system.
 * Guard flag prevents double-firing.
 */
async function checkSprintCompletion(): Promise<boolean> {
  if (sprintCompletionTriggered) return false;

  const snapshot = getSnapshot();
  const currentSprintId = snapshot.company.currentSprintId;
  if (!currentSprintId) return false;

  const currentSprint = snapshot.sprints.find((s) => s.id === currentSprintId);
  if (!currentSprint || currentSprint.status === "completed" || currentSprint.status === "reviewing") return false;

  // Exclude follow_up and bug_fix tasks from completion check (they're part of the review cycle)
  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === currentSprintId && t.kind !== "follow_up" && t.kind !== "bug_fix",
  );
  if (sprintTasks.length === 0) return false;

  const allTerminal = sprintTasks.every((t) =>
    ["completed", "cancelled", "failed"].includes(t.status),
  );
  if (!allTerminal) {
    const statusCounts = { completed: 0, planned: 0, in_progress: 0, failed: 0, cancelled: 0, created: 0 } as Record<string, number>;
    sprintTasks.forEach(t => { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });
    emitEmployeeActivity("system", "context", `Sprint ${currentSprint.number} completion check: NOT all terminal — ${JSON.stringify(statusCounts)}`, {
      detail: { sprintNumber: currentSprint.number, totalTasks: sprintTasks.length, statusCounts },
    });
    return false;
  }

  sprintCompletionTriggered = true;

  // ── Spec 21: Enter sprint reviewing phase ──────────────────

  emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} → REVIEWING (all implementation tasks terminal)`, {
    detail: { sprintNumber: currentSprint.number, sprintId: currentSprintId },
  });

  const reviewState = createReviewState(3);

  updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    status: "reviewing" as Sprint["status"],
    reviewState,
  }));

  // Run pre-review build gate
  const productDir = workspaceManager.getLegacyProductDir();
  const gateResult = await runVerificationGate(productDir, "pre_review");

  reviewState.gateResults.push(gateResult);

  if (!gateResult.passed) {
    // Build failed → create a bug_fix task for developer
    emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} pre-review gate FAILED — creating build fix task`, {
      detail: { gateResult },
    });

    const bugFields = buildGateFailureBugFields(gateResult, currentSprintId);
    if (bugFields) {
      const bugTask = createWorkflowTask(
        getSnapshot(), bugFields.kind, bugFields.assignedRole,
        bugFields.title, bugFields.description, bugFields.problemStatement,
        bugFields.deliverable, bugFields.definitionOfDone, bugFields.priority, "planned",
        bugFields.sprintId,
      );
      upsertTask(bugTask);
      reviewState.bugTaskIds.push(bugTask.id);
      reviewState.phase = "rework";
      emitReactive(bugFields.assignedRole, "bug_reported");
    }
  } else {
    // Build passed → advance to tester verification
    emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} pre-review gate PASSED — awaiting tester verification`, {
      detail: { gateResult },
    });
    reviewState.phase = "tester_verification";
    emitReactive("tester", "task_assigned");
  }

  // Persist the updated review state
  updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    reviewState,
  }));

  sprintCompletionTriggered = false;
  return true;
}

/**
 * Complete the sprint after the reviewing phase is done (Spec 21).
 * Called when the final gate passes or CTO decides to skip.
 */
async function finalizeSprintCompletion(sprintId: string): Promise<void> {
  const snapshot = getSnapshot();
  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  if (!sprint) return;

  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === sprintId && t.kind !== "follow_up",
  );
  const completedCount = sprintTasks.filter((t) => t.status === "completed").length;
  const failedCount = sprintTasks.filter((t) => t.status === "failed").length;
  const cancelledCount = sprintTasks.filter((t) => t.status === "cancelled").length;

  emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} → COMPLETED (${completedCount}/${sprintTasks.length} delivered, ${failedCount} failed, ${cancelledCount} cancelled)`, {
    detail: { sprintNumber: sprint.number, sprintId, completedCount, failedCount, cancelledCount, totalTasks: sprintTasks.length },
  });

  updateSprint(sprintId, (s) => ({
    ...s,
    status: "completed" as Sprint["status"],
    completedAt: nowIso(),
    summary: `Sprint ${s.number} completed — ${completedCount}/${sprintTasks.length} tasks delivered.`,
    reviewState: s.reviewState ? { ...s.reviewState, phase: "complete" as const, completedAt: nowIso() } : s.reviewState,
  }));

  await tagCurrentSprintSnapshot();

  const ceoAgent = getAgentByRole(snapshot, "ceo");
  appendChatMessage({
    id: `chat_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    sprintId,
    agentId: ceoAgent?.id ?? null,
    role: "ceo",
    content: `Sprint ${sprint.number} is complete. ${completedCount} tasks delivered, ${failedCount} failed. Preparing next sprint proposal now.`,
    cardType: "status_update",
    cardData: null,
    createdAt: nowIso(),
  });

  await triggerCeoSprintProposal();
}

/**
 * Handle tester verification beat action during sprint review (Spec 21).
 * Runs the tester LLM to produce a QA report, then either advances the review
 * or creates bug_fix tasks.
 */
async function executeSprintReviewVerification(
  ctx: import("@arceus/contracts").AgentBeatContext,
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  const snapshot = getSnapshot();
  const sprint = ctx.currentSprint;
  if (!sprint || sprint.status !== "reviewing") {
    return { summary: "Sprint not in reviewing state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const reviewState: SprintReviewState | null = (sprint as any).reviewState ?? null;
  if (!reviewState) {
    return { summary: "No review state found", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const sprintId = sprint.id;
  const role = ctx.role;
  const soul = getRoleSoul(role);

  // Build the tester verification prompt
  const completedTasks = snapshot.tasks.filter(
    (t) => t.sprintId === sprintId && t.status === "completed" && t.kind !== "bug_fix" && t.kind !== "follow_up",
  );

  const taskLines = completedTasks.map((t) =>
    `- [${t.id}] ${t.title}\n  Kind: ${t.kind}\n  DoD: ${t.definitionOfDone.join(", ")}\n  Artifacts: ${t.artifactIds.length}`
  ).join("\n");

  // Hard gate: preview must be reachable for a valid sprint review
  const previewProbe = await probePreviewHealth(8000);
  const previewUrl = getLocalPreviewState().validationUrl ?? getLocalPreviewState().entryUrl ?? getLocalPreviewState().url;

  if (!previewProbe.reachable) {
    emitEmployeeActivity("tester", "error", `Beat ${beatId}: preview unreachable (${previewProbe.error}) — auto-failing sprint verification`, { beatId });
  }

  const prompt = [
    `You are verifying Sprint ${sprint.number}: "${sprint.goal}".`,
    "",
    "## Completed Tasks",
    taskLines || "(No completed tasks)",
    "",
    "## Preview Health Check (automated)",
    `Preview status: ${previewProbe.reachable ? "REACHABLE" : "UNREACHABLE"}`,
    `Preview URL: ${previewUrl ?? "none"}`,
    previewProbe.reachable
      ? `HTTP status: ${previewProbe.statusCode}`
      : `Error: ${previewProbe.error ?? "unknown"}`,
    "",
    "IMPORTANT: If the preview is UNREACHABLE, the sprint MUST fail. A product that cannot be accessed is not shippable.",
    "",
    "## Your Verification Steps",
    "1. Check the automated preview health result above — if unreachable, verdict MUST be fail",
    "2. Analyze each completed task against its Definition of Done",
    "3. Identify any defects or gaps",
    "4. Produce a structured QA report",
    "",
    "## QA Report Format (required)",
    "Output a JSON block with this structure:",
    '{"verdict":"pass"|"fail","tasks":[{"taskId":"...","verdict":"pass"|"fail","findings":[{"defect_area":"build_failure"|"test_failure"|"ui_rendering"|"ui_interaction"|"api_behavior"|"accessibility"|"content"|"design_mismatch"|"logic_error"|"performance","severity":"critical"|"high"|"medium"|"low","description":"...","expected":"...","actual":"...","file":"...","fix_suggestion":"..."}],"dod_checklist":[{"item":"...","status":"pass"|"fail","evidence":"..."}]}],"test_files_written":[],"build_status":"pass"|"fail"|"skipped","test_suite_status":"pass"|"fail"|"skipped"|"no_tests"}',
  ].join("\n");

  try {
    const session = await ensureAgentSession(snapshot, role);
    touchAgentSession(role, "working");
    emitEmployeeActivity(role, "working", `Beat ${beatId}: running sprint verification for Sprint ${sprint.number}`, { beatId });

    const output = await runPromptText(role, session.sessionId, soul.systemPrompt + getAgentSkills(role), prompt);
    touchAgentSession(role, "idle");

    const tokensUsed = drainBeatTokenAccumulator(beatId);

    // Try to parse QA report from output
    const qaReport = output ? parseQAReport(output) : null;

    // Hard override: if preview is unreachable, force fail regardless of LLM verdict
    const effectiveVerdict = !previewProbe.reachable ? "fail"
      : qaReport ? qaReport.verdict
      : null;

    if (effectiveVerdict === "pass") {
      // Tester approves → advance to final gate
      emitEmployeeActivity("tester", "transition", `Sprint ${sprint.number} tester verdict: PASS — advancing to final gate`, { beatId });

      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? { ...s.reviewState, testerVerdict: "pass" as const, phase: "final_gate" as const } : s.reviewState,
      }));

      // Persist a QA report artifact (Spec 08 — sprint/task/fileReferences flow
      // through to the hippocampus.artifacts row via the expanded
      // PersistedRuntimeArtifact shape).
      await persistRuntimeArtifact(snapshot.company.id, {
        id: `artifact_${crypto.randomUUID()}`,
        agent: "tester",
        kind: "qa_report",
        title: `Sprint ${sprint.number} QA Report — PASS`,
        content: output ?? "Verification passed",
        createdAt: nowIso(),
        sprintId,
        taskId: null,
        fileReferences: (qaReport?.testFilesWritten ?? []).map((f) => ({ path: f, action: "created" })),
      });

      return { summary: `Tester verification PASS for Sprint ${sprint.number}`, tokensUsed, actionsCount: 1, toolCalls: 1 };

    } else if (effectiveVerdict === "fail") {
      // Tester found bugs (or preview unreachable) → create bug_fix tasks
      const failReason = !previewProbe.reachable
        ? `Preview unreachable: ${previewProbe.error}`
        : "Tester QA report verdict: FAIL";
      emitEmployeeActivity("tester", "transition", `Sprint ${sprint.number} tester verdict: FAIL — ${failReason}`, { beatId });

      const updatedReviewState: SprintReviewState = {
        ...(reviewState as SprintReviewState),
        testerVerdict: "fail",
        phase: "rework",
        reworkCycleCount: reviewState.reworkCycleCount + 1,
      };

      const newBugTaskIds: string[] = [...reviewState.bugTaskIds];
      const rolesWithBugs = new Set<AgentIdentity["role"]>();

      // If preview unreachable and no QA report, create a targeted bug for developer
      if (!previewProbe.reachable && (!qaReport || qaReport.tasks.length === 0)) {
        const bugTask = createWorkflowTask(
          getSnapshot(), "bug_fix", "developer",
          "Fix preview — app unreachable",
          `The product preview is not reachable. Error: ${previewProbe.error ?? "unknown"}. The app must start and respond to HTTP requests before the sprint can pass.`,
          `Preview URL ${previewUrl ?? "(none)"} returns error: ${previewProbe.error ?? "no response"}.`,
          "Working preview that responds with HTTP 200",
          ["Preview URL responds with HTTP 200", "App renders without connection errors"],
          "critical", "planned", sprintId,
        );
        upsertTask(bugTask);
        newBugTaskIds.push(bugTask.id);
        rolesWithBugs.add("developer");
      }

      for (const taskReport of (qaReport?.tasks ?? [])) {
        if (taskReport.verdict !== "fail") continue;
        for (const finding of taskReport.findings) {
          const bugFields = buildBugFixTaskFields({
            finding: {
              ...finding,
              taskId: taskReport.taskId,
            },
            sprintId,
            parentTaskId: taskReport.taskId,
          });
          const bugTask = createWorkflowTask(
            getSnapshot(), bugFields.kind, bugFields.assignedRole,
            bugFields.title, bugFields.description, bugFields.problemStatement,
            bugFields.deliverable, bugFields.definitionOfDone, bugFields.priority, "planned",
            bugFields.sprintId,
          );
          bugTask.parentTaskId = bugFields.parentTaskId;
          upsertTask(bugTask);
          newBugTaskIds.push(bugTask.id);
          rolesWithBugs.add(bugFields.assignedRole);

          // Create feedback round for audit trail
          const feedbackRound = {
            id: `fb_${crypto.randomUUID()}`,
            companyId: snapshot.company.id,
            taskId: bugTask.id,
            iteration: updatedReviewState.reworkCycleCount,
            fromRole: "tester" as const,
            toRole: bugFields.assignedRole,
            verdict: "revise" as const,
            feedback: finding.description,
            artifactIds: [],
            createdAt: nowIso(),
          };
          // Store feedback round in snapshot
          const snap = getSnapshot();
          const updatedFeedback = [...(snap.feedbackRounds ?? []), feedbackRound];
          // We can't directly push — use store's upsert pattern
        }
      }

      updatedReviewState.bugTaskIds = newBugTaskIds;

      // Check if we've exceeded rework limit → escalate
      if (shouldEscalate(updatedReviewState)) {
        updatedReviewState.phase = "escalated";
        updatedReviewState.escalatedToCto = true;
        emitEmployeeActivity("tester", "transition", `Sprint ${sprint.number} rework limit reached (${updatedReviewState.reworkCycleCount}/${updatedReviewState.maxReworkCycles}) — escalating to CTO`, { beatId });
        emitReactive("cto", "escalation_received");
      }

      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: updatedReviewState,
      }));

      // Wake all affected roles
      for (const bugRole of rolesWithBugs) {
        emitReactive(bugRole, "bug_reported");
      }

      // Persist QA report artifact (FAIL branch — same expanded shape as PASS)
      await persistRuntimeArtifact(snapshot.company.id, {
        id: `artifact_${crypto.randomUUID()}`,
        agent: "tester",
        kind: "qa_report",
        title: `Sprint ${sprint.number} QA Report — FAIL (cycle ${updatedReviewState.reworkCycleCount})`,
        content: output ?? "Verification failed",
        createdAt: nowIso(),
        sprintId,
        taskId: null,
        fileReferences: [],
      });

      return {
        summary: `Tester verification FAIL for Sprint ${sprint.number} — ${newBugTaskIds.length - reviewState.bugTaskIds.length} new bugs filed`,
        tokensUsed, actionsCount: 1, toolCalls: 1,
      };

    } else {
      // Couldn't parse QA report — treat as FAIL (don't let ambiguity pass)
      emitEmployeeActivity("tester", "error", `Sprint ${sprint.number} tester output could not be parsed as QA report — treating as FAIL`, { beatId });
      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? { ...s.reviewState, testerVerdict: "fail" as const, phase: "rework" as const, reworkCycleCount: (s.reviewState.reworkCycleCount ?? 0) + 1 } : s.reviewState,
      }));
      return { summary: `Tester output unparseable — treating as fail, returning to rework`, tokensUsed, actionsCount: 1, toolCalls: 1 };
    }
  } catch (err) {
    touchAgentSession(role, "idle");
    emitEmployeeActivity(role, "error", `Beat ${beatId}: sprint verification failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    return {
      summary: `Sprint verification failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }
}

/**
 * Run the final verification gate (build + test) and complete the sprint if it passes.
 * Called by the tester's checklist action when reviewState.phase === "final_gate".
 */
async function executeSprintFinalGate(
  _ctx: import("@arceus/contracts").AgentBeatContext,
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  const snapshot = getSnapshot();
  const sprintId = snapshot.company.currentSprintId;
  if (!sprintId) {
    return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  if (!sprint || sprint.status !== "reviewing") {
    return { summary: "Sprint not in reviewing state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const reviewState: SprintReviewState | null = (sprint as any).reviewState ?? null;
  if (!reviewState) {
    return { summary: "No review state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const productDir = workspaceManager.getLegacyProductDir();
  const gateResult = await runVerificationGate(productDir, "final");

  const updatedGateResults = [...reviewState.gateResults, gateResult];

  if (gateResult.passed) {
    emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} final gate PASSED — completing sprint`, { beatId, detail: { gateResult } });

    updateSprint(sprintId, (s) => ({
      ...s,
      reviewState: s.reviewState ? { ...s.reviewState, gateResults: updatedGateResults, phase: "complete" as const, completedAt: nowIso() } : s.reviewState,
    }));

    await finalizeSprintCompletion(sprintId);

    return {
      summary: `Sprint ${sprint.number} final gate PASSED — sprint completed`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
    };
  } else {
    // Final gate failed → create bug task, back to rework
    emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} final gate FAILED — back to rework`, { beatId, detail: { gateResult } });

    const bugFields = buildGateFailureBugFields(gateResult, sprintId);
    const newBugIds = [...reviewState.bugTaskIds];
    if (bugFields) {
      const bugTask = createWorkflowTask(
        getSnapshot(), bugFields.kind, bugFields.assignedRole,
        bugFields.title, bugFields.description, bugFields.problemStatement,
        bugFields.deliverable, bugFields.definitionOfDone, bugFields.priority, "planned",
        bugFields.sprintId,
      );
      upsertTask(bugTask);
      newBugIds.push(bugTask.id);
      emitReactive(bugFields.assignedRole, "bug_reported");
    }

    const newReworkCount = reviewState.reworkCycleCount + 1;
    const escalate = newReworkCount >= reviewState.maxReworkCycles;

    updateSprint(sprintId, (s) => ({
      ...s,
      reviewState: s.reviewState ? {
        ...s.reviewState,
        gateResults: updatedGateResults,
        bugTaskIds: newBugIds,
        reworkCycleCount: newReworkCount,
        phase: (escalate ? "escalated" : "rework") as any,
        escalatedToCto: escalate || s.reviewState.escalatedToCto,
      } : s.reviewState,
    }));

    if (escalate) {
      emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} rework limit exceeded — escalating to CTO`, { beatId });
      emitReactive("cto", "escalation_received");
    }

    return {
      summary: `Sprint ${sprint.number} final gate FAILED — ${escalate ? "escalated to CTO" : "back to rework"}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
    };
  }
}

/**
 * Handle the transition from rework → tester_verification when all bugs are fixed.
 * Called by the tester's checklist action.
 */
async function executeRetestAfterRework(
  _ctx: import("@arceus/contracts").AgentBeatContext,
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  const snapshot = getSnapshot();
  const sprintId = snapshot.company.currentSprintId;
  if (!sprintId) {
    return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  emitEmployeeActivity("tester", "transition", `Bug fixes resolved — advancing to tester re-verification`, { beatId });

  // Clear the bugTaskIds and advance phase
  updateSprint(sprintId, (s) => ({
    ...s,
    reviewState: s.reviewState ? {
      ...s.reviewState,
      phase: "tester_verification" as const,
      bugTaskIds: [],  // clear for next cycle
      testerVerdict: null,
    } : s.reviewState,
  }));

  return {
    summary: `Bug fixes resolved — tester will re-verify on next beat`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0,
  };
}

// ── CTO Escalation Review (Spec 21) ─────────────────────────

const ctoEscalationDecisionSchema = z.object({
  decision: z.enum(["fix", "skip", "abort"]),
  reasoning: z.string(),
  criticalBugs: z.array(z.string()).optional(),
});

async function executeCtoBeatEscalationReview(
  _ctx: import("@arceus/contracts").AgentBeatContext,
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  startBeatTokenAccumulator(beatId);
  const snapshot = getSnapshot();
  const sprintId = snapshot.company.currentSprintId;
  if (!sprintId) {
    return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  const reviewState = sprint?.reviewState;
  if (!sprint || !reviewState || !reviewState.escalatedToCto) {
    return { summary: "No escalation pending", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  emitEmployeeActivity("cto", "working", `Beat ${beatId}: reviewing escalated Sprint ${sprint.number} (${reviewState.reworkCycleCount} rework cycles exhausted)`, { beatId });

  // Gather context: bug tasks and their status
  const bugTasks = reviewState.bugTaskIds
    .map((id) => snapshot.tasks.find((t) => t.id === id))
    .filter(Boolean);

  const bugSummary = bugTasks.map((t) =>
    `- [${t!.status}] ${t!.title}: ${t!.description?.slice(0, 150) ?? "no description"}`
  ).join("\n");

  const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === sprintId);
  const completedCount = sprintTasks.filter((t) => t.status === "completed").length;
  const failedCount = sprintTasks.filter((t) => t.status === "failed").length;

  const prompt = [
    `Sprint ${sprint.number} "${sprint.title}" has been escalated to you after ${reviewState.reworkCycleCount} failed rework cycles (max ${reviewState.maxReworkCycles}).`,
    ``,
    `Sprint progress: ${completedCount}/${sprintTasks.length} tasks completed, ${failedCount} failed.`,
    `Tester verdict: ${reviewState.testerVerdict ?? "unknown"}`,
    ``,
    `Remaining bug tasks:`,
    bugSummary || "(none tracked)",
    ``,
    `You must decide:`,
    `- "fix": Force one more targeted rework cycle on the critical bugs only`,
    `- "skip": Ship the sprint as-is, accepting known defects as tech debt`,
    `- "abort": Cancel the sprint entirely and re-plan`,
    ``,
    `Consider: severity of remaining bugs, business impact, and whether another rework cycle is likely to succeed.`,
  ].join("\n");

  try {
    const result = await structuredCompletion(
      "workerDeployment",
      [
        { role: "system", content: "You are the CTO making a ship-or-kill decision on an escalated sprint. Be decisive and justify your reasoning." },
        { role: "user", content: prompt },
      ],
      ctoEscalationDecisionSchema,
      "cto_escalation_review",
      { temperature: 0.3 },
    );

    const decision = result.decision;
    const tokensUsed = drainBeatTokenAccumulator(beatId);

    emitEmployeeActivity("cto", "decision", `Beat ${beatId}: CTO escalation decision = ${decision} — ${result.reasoning.slice(0, 200)}`, {
      beatId, detail: { decision, reasoning: result.reasoning },
    });

    // Apply the decision
    updateSprint(sprintId, (s) => ({
      ...s,
      reviewState: s.reviewState ? {
        ...s.reviewState,
        ctoDecision: decision,
      } : s.reviewState,
    }));

    if (decision === "fix") {
      // Allow one more rework cycle — reset phase to rework, bump max by 1
      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? {
          ...s.reviewState,
          phase: "rework" as const,
          maxReworkCycles: s.reviewState.maxReworkCycles + 1,
        } : s.reviewState,
      }));
      // Wake affected roles
      for (const bugTask of bugTasks) {
        if (bugTask?.assignedRole) {
          emitReactive(bugTask.assignedRole, "bug_reported");
        }
      }
      emitEmployeeActivity("cto", "transition", `Beat ${beatId}: CTO granted extra rework cycle — Sprint ${sprint.number} back to rework`, { beatId });
    } else if (decision === "skip") {
      // Ship as-is — advance to final gate (tests may still fail, but CTO accepts)
      updateSprint(sprintId, (s) => ({
        ...s,
        reviewState: s.reviewState ? {
          ...s.reviewState,
          phase: "complete" as const,
          completedAt: new Date().toISOString(),
        } : s.reviewState,
      }));
      await finalizeSprintCompletion(sprintId, sprint.number, beatId);
      emitEmployeeActivity("cto", "transition", `Beat ${beatId}: CTO shipped Sprint ${sprint.number} with known defects`, { beatId });
    } else if (decision === "abort") {
      // Cancel sprint
      updateSprint(sprintId, (s) => ({
        ...s,
        status: "completed" as const,
        completedAt: new Date().toISOString(),
        summary: `Aborted by CTO after ${reviewState.reworkCycleCount} rework cycles: ${result.reasoning.slice(0, 300)}`,
        reviewState: s.reviewState ? {
          ...s.reviewState,
          phase: "complete" as const,
          completedAt: new Date().toISOString(),
        } : s.reviewState,
      }));
      emitEmployeeActivity("cto", "transition", `Beat ${beatId}: CTO aborted Sprint ${sprint.number} — will need re-planning`, { beatId });
      // Wake CEO to propose next sprint
      emitReactive("ceo", "sprint_completed");
    }

    return {
      summary: `CTO escalation review: ${decision} — ${result.reasoning.slice(0, 300)}`,
      tokensUsed, actionsCount: 1, toolCalls: 1,
    };
  } catch (err) {
    const tokensUsed = drainBeatTokenAccumulator(beatId);
    emitEmployeeActivity("cto", "error", `Beat ${beatId}: CTO escalation review failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    return {
      summary: `CTO escalation review failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed, actionsCount: 0, toolCalls: 0,
    };
  }
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

  // ── Audit: task modification (assign, reassign, cancel, etc.) ──
  if (modification.modificationType === "assign" || modification.modificationType === "reassign") {
    const companyId = getSnapshot().company.id;
    audit({
      companyId,
      category: "task_lifecycle",
      eventType: "task_assigned",
      summary: `Task "${modification.taskId}" ${modification.modificationType} → ${modification.assignedRole ?? "unassigned"}`,
      detail: {
        taskId: modification.taskId,
        modificationType: modification.modificationType,
        assignedRole: modification.assignedRole ?? null,
        details: modification.details,
      },
      correlationId: modification.taskId,
    });

    // Reactive: wake the assigned agent
    if (modification.assignedRole) {
      emitReactive(modification.assignedRole, "task_assigned");
    }
  } else if (modification.modificationType === "cancel") {
    const companyId = getSnapshot().company.id;
    audit({
      companyId,
      category: "task_lifecycle",
      severity: "warn",
      eventType: "task_cancelled",
      summary: `Task "${modification.taskId}" cancelled: ${modification.details.slice(0, 100)}`,
      detail: { taskId: modification.taskId, reason: modification.details },
      correlationId: modification.taskId,
    });
  }
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

  // Reactive: wake each participant agent (board directive)
  for (const role of participantRoles) {
    if (role !== "ceo") emitReactive(role, "board_message");
  }
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

  // Reactive: escalation meetings wake participant agents
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
  const prev = getSnapshot().tasks.find((t) => t.id === taskId);
  const prevStatus = prev?.status ?? "unknown";
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

  // Audit task transitions
  audit({
    companyId: prev?.companyId ?? getSnapshot().company.id,
    category: "task_lifecycle",
    severity: status === "failed" ? "warn" : "info",
    eventType: `task_${status}`,
    agentRole: prev?.assignedRole ?? null,
    summary: `Task "${prev?.title ?? taskId}" ${prevStatus} → ${status}`,
    detail: { taskId, previousStatus: prevStatus, feedback: feedback ?? null },
    correlationId: taskId,
  });

  // Auto-promote downstream tasks when a task completes
  if (status === "completed") {
    const snapshot = getSnapshot();
    const completedTask = snapshot.tasks.find((t) => t.id === taskId);

    // Propagate artifacts from the completed task to its direct children
    // so downstream employees receive upstream work products as context.
    if (completedTask && completedTask.artifactIds.length > 0) {
      for (const childId of completedTask.childTaskIds) {
        updateTask(childId, (t) => ({
          ...t,
          incomingArtifactIds: uniqueStrings([...t.incomingArtifactIds, ...completedTask.artifactIds], 20),
        }));
      }
    }

    for (const task of snapshot.tasks) {
      if (task.status !== "created") continue;
      if (task.kind === "follow_up") continue;
      if (task.dependsOnTaskIds.length === 0) continue;
      const allDepsMet = task.dependsOnTaskIds.every((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return dep?.status === "completed";
      });
      if (allDepsMet) {
        // Also propagate artifacts from all completed dependencies
        const upstreamArtifactIds: string[] = [];
        for (const depId of task.dependsOnTaskIds) {
          const dep = snapshot.tasks.find((t) => t.id === depId);
          if (dep) upstreamArtifactIds.push(...dep.artifactIds);
        }
        updateTask(task.id, (t) => ({
          ...t,
          status: "planned" as Task["status"],
          incomingArtifactIds: uniqueStrings([...t.incomingArtifactIds, ...upstreamArtifactIds], 20),
        }));
        // Reactive: wake the assignee — their dependency is now met
        if (task.assignedRole) {
          emitReactive(task.assignedRole, "task_dependency_met");
        }
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
          console.warn(`[Hippocampus] processTaskCompletion failed for ${task.id}: ${describePgError(err)}`);
        });
      }

      // Spec 14 Phase 2: update success rates + trigger failure attribution
      // Replaces old inline matchSkills+updateSuccessRate (Path B).
      // processTaskOutcome handles: success rate EMA, failure attribution, mutation proposal.
      // Fire-and-forget — never blocks task progression.
      if (status === "completed" || status === "failed") {
        processTaskOutcome({
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          assignedRole: task.assignedRole,
          companyId: snapshot.company.id,
          status,
          iterationCount: task.iterationCount,
          executionTrace: feedback ?? undefined,
        }).then((mutation) => {
          if (mutation) {
            console.log(`[SkillMutator] Proposed ${mutation.originalSkillId ? "mutation" : "discovery"}: ${mutation.id} (${mutation.reason})`);
            // Phase 3: Auto-trigger ATA pipeline (async, never blocks)
            runATAPipeline(mutation.id).then((result) => {
              console.log(`[ATA] ${result.verdict.toUpperCase()} for ${mutation.id} (score=${result.reviewVerdict.overallScore}, revisions=${result.revisionCycles})`);
            }).catch((err) => {
              console.warn(`[ATA] Pipeline error for ${mutation.id}: ${err instanceof Error ? err.message : err}`);
            });
          }
        }).catch((err) => {
          console.warn(`[SkillMutator] processTaskOutcome error for ${task.id}: ${err instanceof Error ? err.message : err}`);
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

  // Inject upstream artifacts from task's incomingArtifactIds. Heartbeat-only.
  const upstreamContext = resolveIncomingArtifacts(task);
  if (upstreamContext.length > 0) {
    profileHints.push(...upstreamContext);
  }

  // ── Role-specific output requirements ──
  if (task.assignedRole === "pm") {
    profileHints.push(
      "",
      "# Output requirements — Product Manager",
      "You MUST produce a structured specification document, NOT a generic status update.",
      "Do NOT write vague prose like 'clarified scope'. Write the ACTUAL spec.",
      "Your output is the primary input for the Developer — if it's vague, the product will be wrong.",
      "",
      "Required sections (include ALL of these with CONCRETE content):",
      "",
      "## 1. User Stories",
      "Write 3–8 user stories in the format: 'As a [user], I want [action] so that [benefit]'.",
      "Each story MUST have numbered acceptance criteria (Given/When/Then or checkbox format).",
      "",
      "## 2. Functional Requirements",
      "List every feature the developer must implement. Be specific:",
      "- BAD: 'Users can manage notes'",
      "- GOOD: 'Users can create a new note with a title (max 200 chars) and body (Markdown supported). Notes persist across page reloads via localStorage. Each note has a created_at timestamp.'",
      "",
      "## 3. UI/UX Requirements",
      "Describe the screens/views, layout structure, key interactions, and navigation flow.",
      "Name specific components (sidebar, note list, editor pane, tag picker, etc.).",
      "",
      "## 4. Non-functional Requirements",
      "Performance targets, browser support, accessibility level, data persistence strategy.",
      "",
      "## 5. Out of Scope (Non-goals)",
      "Explicitly list what is NOT part of this sprint.",
      "",
      "## 6. Definition of Done",
      "Measurable checklist of what 'done' means for the developer.",
    );
  } else if (task.assignedRole === "ui_designer") {
    profileHints.push(
      "",
      "# Output requirements — UI Designer",
      "You MUST produce actionable design specifications that a developer can directly implement.",
      "Do NOT write vague prose like 'designed intuitive layouts'. Provide EXACT specs.",
      "",
      "Required sections (include ALL with CONCRETE values):",
      "",
      "## 1. Layout Structure",
      "Describe the page layout using CSS terms: grid template, flex direction, sidebar width, main content area.",
      "Example: 'Two-column layout: fixed 260px sidebar on left, flexible main area. Sidebar has logo area (64px height), search input, folder list, tag cloud.'",
      "",
      "## 2. Component Hierarchy",
      "List every React component the developer should create, with props and children:",
      "- AppShell → Sidebar + MainContent",
      "- Sidebar → SearchInput + FolderList + TagCloud",
      "- MainContent → NoteListHeader + NoteList | NoteEditor",
      "- NoteEditor → TitleInput + MarkdownEditor + TagPicker",
      "",
      "## 3. Design Tokens",
      "Provide EXACT values the developer must use:",
      "- Colors: background, surface, text-primary, text-secondary, accent, border (hex codes)",
      "- Typography: font-family, size scale (h1–body–caption), line heights, weights",
      "- Spacing: base unit (e.g. 8px), padding/margin for key elements",
      "- Border radius, shadow values",
      "- Breakpoints for responsive behavior",
      "",
      "## 4. Component States",
      "For each interactive component, specify: default, hover, active, focus, disabled, loading, empty, error states.",
      "",
      "## 5. Interactions & Animations",
      "Describe transitions, hover effects, and micro-interactions with duration and easing.",
      "Example: 'Note list item: hover scales to 1.01 with 150ms ease-out, background shifts to surface-hover color.'",
      "",
      "## 6. Responsive Behavior",
      "How does the layout adapt at mobile (<640px), tablet (640–1024px), and desktop (>1024px)?",
    );
  } else if (task.assignedRole === "marketing") {
    profileHints.push(
      "",
      "# Output requirements — Marketing",
      "Return a concise execution artifact with these sections:",
      "1. Target audience and messaging strategy",
      "2. Concrete deliverables produced (copy, assets, channel plans)",
      "3. Key messages and value propositions",
      "4. Distribution channels and timeline",
      "5. Success metrics and next steps",
    );
  } else {
    profileHints.push(
      "",
      "# Output requirements",
      "Return a concise execution artifact with these sections:",
      "1. Objective alignment",
      "2. What you did (be specific — name files, tools, concrete actions)",
      "3. Evidence or concrete results",
      "4. Open issues or blockers",
      "5. Recommendation for next steps",
    );
  }

  return profileHints.join("\n");
}

/**
 * Resolve incoming artifact content for a task.
 * Returns labelled sections for CTO plan, PM acceptance, and other upstream artifacts.
 */
function resolveIncomingArtifacts(task: Task): string[] {
  const lines: string[] = [];
  if (task.incomingArtifactIds.length === 0) return lines;

  let budget = 6000;
  for (const artifactId of task.incomingArtifactIds) {
    if (budget <= 0) break;
    const artifact = artifacts.find((a) => a.id === artifactId);
    if (!artifact) continue;
    const snippet = artifact.content.slice(0, budget);
    // Use the artifact kind to give a meaningful header
    const header = artifact.kind === "plan" ? "CTO Technical Plan"
      : artifact.kind === "specification" ? "PM Acceptance Criteria"
      : `Upstream Artifact: ${artifact.title}`;
    lines.push("", `# ${header}`, snippet);
    budget -= snippet.length;
  }
  return lines;
}

/**
 * Build a prompt for developer beats that instructs the agent to actually write code.
 * Unlike buildSpecialistTaskPrompt (text-only), this enables tool use.
 */
function buildDeveloperBeatPrompt(task: Task, existingFiles?: string[]) {
  const preview = getLocalPreviewState();
  const lines = [
    `# Task`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Problem statement: ${task.problemStatement}`,
    `Deliverable: ${task.deliverable}`,
    `Definition of done:`,
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    `# Workspace`,
    `Product directory: ${productDir}`,
    `All code MUST be written inside ${productDir}. Do NOT modify files outside this directory.`,
    `Current preview: ${preview.status === "ready" ? (preview.url ?? "running") : "not running"}`,
  ];

  // Include a manifest of existing files so the LLM knows what the codebase looks like
  if (existingFiles && existingFiles.length > 0) {
    lines.push("", `# Existing files in workspace (${existingFiles.length} files)`);
    // Cap at 100 files to avoid token bloat
    const shown = existingFiles.slice(0, 100);
    for (const f of shown) {
      lines.push(`- ${f}`);
    }
    if (existingFiles.length > 100) {
      lines.push(`... and ${existingFiles.length - 100} more`);
    }
  } else {
    lines.push("", `# Existing files in workspace`, `No files found — this is a fresh workspace. The project will be auto-scaffolded.`);
  }

  lines.push(
    "",
    `# Instructions`,
    `You are a software developer. IMPLEMENT this task by writing real code using your tools.`,
    `The workspace is pre-configured with: Vite + React 18 + TypeScript + Tailwind CSS 3 + shadcn/ui utilities.`,
    `Design tokens and a style guide are in design/style-guide.md — follow them.`,
    `The cn() utility is at src/lib/utils.ts — use it for conditional class merging.`,
    `1. Read existing files in the workspace to understand the current codebase.`,
    `2. Write or edit files to implement the task requirements.`,
    `3. Create components as separate files in src/components/ — NOT everything in App.tsx.`,
    `4. Do NOT run npm create vite, do NOT reconfigure Tailwind — it's already set up.`,
    `5. Do NOT start a dev server — preview is handled separately.`,
    `6. After writing code, briefly summarize what you implemented.`,
  );

  // Inject upstream artifacts (CTO plan, PM spec) from task's incomingArtifactIds.
  // Heartbeat-only — the legacy activeExecution fallback was removed with the router loop.
  const upstreamContext = resolveIncomingArtifacts(task);
  if (upstreamContext.length > 0) {
    lines.push(...upstreamContext);
  }

  return lines.join("\n");
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
  // Find the actual artifact content so we can embed it — not just an API URL
  const artifact = artifacts.find((a) => a.id === artifactId);
  const designContent = artifact?.content
    ? artifact.content.slice(0, 4000) // Cap to avoid token bloat
    : `(Design artifact ${artifactId} content not available — request review from UI Designer.)`;

  const guidance = [
    `UI Designer delivered design direction for "${task.title}".`,
    `IMPORTANT: Follow these design specs exactly when implementing UI components.`,
    `--- BEGIN DESIGN SPECS ---`,
    designContent,
    `--- END DESIGN SPECS ---`,
  ].join("\n");

  const qaGuidance = `Verify UI implementation matches the design direction in artifact ${artifactId} for ${task.title}. Check: layout structure, color tokens, component states, responsive behavior.`;

  enrichRoleMemory("developer", {
    currentFocus: [guidance],
    recentLearnings: [guidance],
    activePatterns: ["Follow UI Designer design specs exactly — use specified colors, spacing, typography, and component hierarchy."],
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

    // Reactive: wake the agent who requested the approval
    const snap = getSnapshot();
    const requestor = snap.agents.find((a: { id: string; role: AgentIdentity["role"] }) => a.id === approval.requestedByAgentId);
    if (requestor) {
      emitReactive(requestor.role, "approval_granted");
    }
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

  // ── Dependency gate: skip tasks whose dependencies haven't completed ──
  if (task.dependsOnTaskIds.length > 0) {
    const unmetDeps = task.dependsOnTaskIds.filter((depId) => {
      const dep = snapshot.tasks.find((t) => t.id === depId);
      return !dep || dep.status !== "completed";
    });
    if (unmetDeps.length > 0) {
      const depDetails = unmetDeps.map((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return dep ? `"${dep.title}" [${dep.status}]` : `unknown(${depId})`;
      });
      emitEmployeeActivity(task.assignedRole, "decision", `Specialist task "${task.title}" skipped — ${unmetDeps.length} unmet dependency(ies): ${depDetails.join(", ")}`);
      return;
    }
  }

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

  const output = await runPromptText(role, roleSession.sessionId, soul.systemPrompt + getAgentSkills(role), buildSpecialistTaskPrompt(task));

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
  } else if (role === "cto" && task.kind === "board_handoff") {
    // Hard preview gate: CTO review cannot complete unless preview is healthy
    const reviewProbe = await probePreviewHealth(8000);
    if (!reviewProbe.reachable) {
      setTaskStatus(task.id, "blocked", `CTO review blocked — preview unreachable: ${reviewProbe.error ?? "no response"}. Developer must fix the preview before sprint review can proceed.`);
      emitEmployeeActivity("cto", "error", `Board handoff blocked — preview not reachable (${reviewProbe.error}). Cannot approve sprint without a working product.`, { taskId: task.id });
      recordMeeting({
        type: "escalation",
        facilitatorRole: "cto",
        participantRoles: ["cto", "developer"],
        summary: `CTO board handoff blocked: preview is unreachable (${reviewProbe.error}). Developer must fix the preview.`,
        agenda: [{
          topic: "Preview unreachable",
          type: "blocker" as const,
          content: `The product preview is not reachable. Error: ${reviewProbe.error ?? "unknown"}. The CTO cannot approve a sprint without a working, accessible product.`,
          raisedByRole: "cto" as const,
          relatedTaskId: task.id,
        }],
        decisions: [{
          description: "Developer must restore preview before CTO review can complete.",
          decidedByRoles: ["cto"],
          impactIds: [task.id],
        }],
      });
      return;
    }
    setTaskStatus(task.id, "completed", `CTO review completed — preview verified reachable (HTTP ${reviewProbe.statusCode}).`);
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

/** Map role capabilities to OpenCode tool flags. */
function getToolsForPrompt(role: AgentIdentity["role"]): Record<string, boolean> | undefined {
  const soul = getRoleSoul(role);
  if (!soul.canWriteCode && !soul.canEditFiles && !soul.canRunShell) return undefined;
  return {
    read: true,
    glob: true,
    grep: true,
    ...(soul.canWriteCode ? { write: true, edit: true, apply_patch: true } : {}),
    ...(soul.canEditFiles ? { write: true, edit: true } : {}),
    ...(soul.canRunShell ? { bash: true } : {}),
  };
}

async function runPromptText(role: AgentIdentity["role"], sessionId: string, systemPrompt: string, text: string, tools?: Record<string, boolean>) {
  const deployment = ensureDeployment("workerDeployment");

  // Inject role-specific skills into the system prompt
  const skillMenu = buildSkillMenu(role);
  const skillBody = getSkillBody(role);

  // Inject Hippocampus memory context (never fatal — graceful degradation)
  let memoryBlock = "";
  let memoryCount = 0;
  let habitCount = 0;
  try {
    const snapshot = getSnapshot();
    const agent = getAgentByRole(snapshot, role);
    if (agent) {
      const ctx = await hippocampus.prepareAgentContext(agent.id, text);
      memoryBlock = formatHippocampusContext(ctx);
      memoryCount = ctx.memories.length;
      habitCount = ctx.habits.length;
    }
  } catch (err) {
    const msg = describePgError(err);
    console.warn(`[Hippocampus] Memory retrieval failed for ${role}, continuing without: ${msg}`);
    emitEmployeeActivity(role, "error", `Hippocampus memory retrieval failed: ${msg}`);
  }

  const enrichedSystemPrompt = [systemPrompt, skillMenu, skillBody, memoryBlock].filter(Boolean).join("\n");

  emitEmployeeActivity(role, "context", `Prompt assembled: system=${systemPrompt.length}ch skill=${skillMenu.length + skillBody.length}ch memory=${memoryBlock.length}ch (${memoryCount} facts, ${habitCount} habits) → total=${enrichedSystemPrompt.length}ch`, {
    detail: {
      systemPromptLen: systemPrompt.length,
      skillMenuLen: skillMenu.length,
      skillBodyLen: skillBody.length,
      memoryBlockLen: memoryBlock.length,
      memoryCount,
      habitCount,
      totalPromptLen: enrichedSystemPrompt.length,
      userPromptLen: text.length,
      model: deployment,
      tools: tools ? Object.keys(tools).filter(k => (tools as any)[k]) : [],
    },
  });

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
      const promptBody: Record<string, unknown> = {
        model: { providerID: "azure", modelID: deployment },
        agent: role,
        system: enrichedSystemPrompt,
        parts: [{ type: "text", text }],
      };
      if (tools) promptBody.tools = tools;

      // OpenCode's session.prompt() is fire-and-forget: it POSTs the message
      // and returns immediately (HTTP 200 with empty body). The actual LLM
      // processing streams via SSE events and finishes with "session.idle".
      // We register a completion waiter BEFORE firing, then await it.
      const completionPromise = registerPromptCompletion(currentSessionId);

      const promptResult = await opencode.client.session.prompt({
        path: { id: currentSessionId },
        body: promptBody as any,
      });
      // Wait for session.idle (or session.error) via the SSE event bridge
      await completionPromise;

      // Now fetch the messages to get the actual LLM response
      const messagesResult = await opencode.client.session.messages({
        path: { id: currentSessionId },
      });

      const messages = messagesResult.data as Array<{ info: any; parts: Array<{ type: string; text?: string }> }> | undefined;
      if (!messages || messages.length === 0) {
        return "";
      }

      // Find the last assistant message and extract text parts
      const assistantMessages = messages.filter((m) => m.info?.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      if (!lastAssistant) return "";

      // Check for OpenCode-level errors embedded in info
      const infoError = lastAssistant.info?.error;
      if (infoError) {
        const errorMsg = infoError.data?.message ?? infoError.name ?? "Unknown OpenCode session error";
        throw new Error(`OpenCode ${role} session error: ${errorMsg}`);
      }

      return (
        lastAssistant.parts
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
  auditSystem(getSnapshot().company.id, "execution_stopped", `Execution stopped: ${reason}`, { severity: "warn" });

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

  // Resolve explicit dependencies by title (best-effort from CEO proposal)
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

  // Implicit ordering: tester/QA tasks must wait for all developer + ui_designer tasks
  const implementationTaskIds = createdTasks
    .filter((t) => t.assignedRole === "developer" || t.assignedRole === "ui_designer")
    .map((t) => t.id);
  if (implementationTaskIds.length > 0) {
    for (let i = 0; i < createdTasks.length; i++) {
      if (createdTasks[i].assignedRole !== "tester") continue;
      const existing = new Set(createdTasks[i].dependsOnTaskIds);
      const merged = [...createdTasks[i].dependsOnTaskIds];
      for (const depId of implementationTaskIds) {
        if (!existing.has(depId)) merged.push(depId);
      }
      createdTasks[i] = {
        ...createdTasks[i],
        dependsOnTaskIds: merged,
        parentTaskId: createdTasks[i].parentTaskId || merged[0],
      };
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

  // Set up activeExecution and kick off. Only fields still read by live code
  // are carried here; the developer/preview task IDs are filled in when the
  // heartbeat promotes those tasks.
  activeExecution = {
    companyId: freshSnapshot.company.id,
    buildTaskId: "",
    previewTaskId: "",
    reviewTaskId: reviewTask.id,
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
 * In heartbeat mode the engine picks up planned tasks automatically, so we only set the
 * execution status and ensure the workspace is ready. We do NOT run the legacy router loop
 * because it would auto-complete developer tasks via executeSpecialistTask before the
 * heartbeat developer beats get a chance to do real coding work.
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

    // Sprint 2+ tasks are picked up by heartbeat beats — no router loop needed.
    // The router loop's Sprint 2+ path would call executeSpecialistTask on
    // implementation tasks (since planText is null), auto-completing them with
    // a text-only LLM call instead of a real developer coding session.
    emitEmployeeActivity(
      "system",
      "info",
      "Sprint execution ready — heartbeat engine will pick up planned tasks.",
    );
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

      // ── Audit: tool invocation / completion ──
      if (toolName && activeExecution) {
        const companyId = activeExecution.companyId;
        const taskId = activeExecution.buildTaskId;
        const sanitizedArgs = sanitizeToolArgs(args);
        if (isInvocation) {
          auditAgent(companyId, role, "tool_invoked", `${role} invoked ${toolName}`, {
            detail: { toolName, args: sanitizedArgs, taskId },
            correlationId: taskId,
            severity: "debug",
          });

          // ── Governance post-hoc enforcement (Spec 13 Step 8) ──
          const snap = getSnapshot();
          const agent = getAgentByRole(snap, role as AgentIdentity["role"]);
          if (agent) {
            const trustData = await cpLoadTrustScore(agent.id);
            const policyCtx: PolicyEvalContext = {
              role: role as PolicyEvalContext["role"], tool: toolName, trustScore: trustData.score,
              companyId, agentId: agent.id,
            };
            const decision = evaluatePolicy(policyCtx, BASE_POLICY_RULES);
            if (decision.decision === "deny") {
              emitEmployeeActivity(role, "error", `Post-hoc violation: ${toolName} denied by rule ${decision.ruleId} — ${decision.reason}`, {
                taskId, detail: { toolName, ruleId: decision.ruleId, decision: decision.decision, trustScore: trustData.score },
              });
              const violationId = `viol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              cpRecordPolicyViolation({
                id: violationId, companyId, agentId: agent.id, ruleId: decision.ruleId,
                tool: toolName, decision: decision.decision, severity: "high",
                detail: `Agent ${role} invoked denied tool ${toolName}: ${decision.reason}`,
                beatId: null,
                resolvedAt: null, createdAt: new Date().toISOString(),
              });
              const trustEvent = buildTrustEvent(agent.id, "violation", `Invoked denied tool ${toolName}`, new Date().toISOString());
              cpUpdateTrustScore(trustEvent);
            } else if (decision.decision === "escalate") {
              emitEmployeeActivity(role, "decision", `Post-hoc escalation: ${toolName} requires approval — rule ${decision.ruleId}`, {
                taskId, detail: { toolName, ruleId: decision.ruleId, trustScore: trustData.score },
              });
            }
          }
        } else {
          auditAgent(companyId, role, "tool_completed", `${role} ${toolName} → ${toolStatus || "done"}`, {
            detail: { toolName, status: toolStatus || "completed", taskId },
            correlationId: taskId,
            severity: "debug",
          });
        }
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
    // If runPromptText() is awaiting this session, resolve its completion promise
    // and return — the caller (e.g. executeBeatTask) handles post-completion routing.
    if (pendingPromptCompletions.has(sessionId)) {
      resolvePromptCompletion(sessionId);
      return;
    }

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

    // Heartbeat regime: all prompt() invocations are awaited via registerPromptCompletion,
    // so reaching here means a session went idle outside of runPromptText — either a
    // legacy step-loop run (removed) or an external trigger. Emit a generic completion
    // log and let the heartbeat scheduler own next-step routing.
    emitEmployeeActivity(role, "idle", "Work complete");
  }

  if (event.type === "session.error" && agentState) {
    const errorMessage = props.error?.message ?? props.error?.data?.message ?? "OpenCode session error";
    // If runPromptText() is awaiting this session, reject its completion promise
    if (pendingPromptCompletions.has(sessionId)) {
      rejectPromptCompletion(sessionId, new Error(errorMessage));
    }

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

// ── Heartbeat integration (Spec 12 Phase 3) ────────────────

/**
 * Execute a task within beat context (no activeExecution global required).
 * Called by BeatDependencies.executeTask().
 */
export async function executeBeatTask(
  ctx: import("@arceus/contracts").AgentBeatContext,
  taskId: string,
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number; completed: boolean }> {
  // Ensure the SSE event bridge is running so runPromptText() completion
  // promises resolve (session.idle / session.error events).
  if (!eventBridgeStarted) {
    startEventBridge().catch(() => {});
    eventBridgeStarted = true;
  }

  startBeatTokenAccumulator(beatId);
  const snapshot = getSnapshot();
  const task = snapshot.tasks.find((t) => t.id === taskId);
  if (!task) {
    emitEmployeeActivity("system", "error", `Beat ${beatId}: task ${taskId} not found in snapshot`, { beatId, detail: { taskId, role: ctx.role } });
    return { summary: `Task ${taskId} not found`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false };
  }

  // ── Dependency gate: skip tasks whose dependencies haven't completed ──
  if (task.dependsOnTaskIds.length > 0) {
    const unmetDeps = task.dependsOnTaskIds.filter((depId) => {
      const dep = snapshot.tasks.find((t) => t.id === depId);
      return !dep || dep.status !== "completed";
    });
    if (unmetDeps.length > 0) {
      const depDetails = unmetDeps.map((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return dep ? `"${dep.title}" [${dep.status}]` : `unknown(${depId})`;
      });
      emitEmployeeActivity(ctx.role, "decision", `Beat ${beatId}: skipping task "${task.title}" — ${unmetDeps.length} unmet dependency(ies): ${depDetails.join(", ")}`, { beatId, taskId });
      return { summary: `Skipped "${task.title}" — waiting on ${unmetDeps.length} dependencies`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false };
    }
  }

  const role = ctx.role;

  // Spec 14: match skills relevant to this task and record usage
  const matchedSkillIds = matchAndRecordSkills(role, `${task.title} ${task.description}`);

  emitEmployeeActivity(role, "context", `Beat ${beatId}: picked task "${task.title}" [${task.status}] priority=${task.priority} matchedSkills=${matchedSkillIds.length}`, {
    beatId, taskId, detail: { taskStatus: task.status, taskPriority: task.priority, assignedRole: task.assignedRole, definitionOfDone: task.definitionOfDone, matchedSkillIds },
  });

  // ── CEO beat: sprint lifecycle detection ──────────────────
  if (role === "ceo") {
    // Don't conflict with live CEO chat streaming
    if (isCeoStreaming()) {
      return {
        summary: "CEO beat skipped — live chat streaming in progress",
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false,
      };
    }
    // Check if all sprint tasks are terminal → trigger next sprint proposal
    const sprintId = snapshot.company.currentSprintId;
    if (sprintId) {
      const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === sprintId);
      const allTerminal = sprintTasks.length > 0 && sprintTasks.every((t) =>
        ["completed", "failed", "cancelled", "blocked"].includes(t.status)
      );
      if (allTerminal) {
        try {
          await triggerCeoSprintProposal();
          return {
            summary: `CEO detected all tasks terminal in sprint ${sprintId} — triggered next sprint proposal`,
            tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1, completed: true,
          };
        } catch (err) {
          return {
            summary: `CEO sprint proposal failed: ${err instanceof Error ? err.message : String(err)}`,
            tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false,
          };
        }
      }
    }

    // CEO proactive governance: budget alert, stale task detection
    const budgetPct = snapshot.company.budgetCents > 0
      ? (snapshot.company.spentCents / snapshot.company.budgetCents) * 100
      : 0;
    if (budgetPct >= 90) {
      emitEmployeeActivity("ceo", "info", `Budget alert: ${budgetPct.toFixed(0)}% spent (${snapshot.company.spentCents}¢ / ${snapshot.company.budgetCents}¢)`, { beatId });
    }

    // Detect stale in-progress tasks (older than 10 minutes)
    const staleThreshold = Date.now() - 10 * 60 * 1000;
    const staleTasks = snapshot.tasks.filter((t) =>
      t.status === "in_progress" && new Date(t.startedAt ?? t.createdAt ?? new Date().toISOString()).getTime() < staleThreshold
    );
    if (staleTasks.length > 0) {
      emitEmployeeActivity("ceo", "info", `Stale task detection: ${staleTasks.length} task(s) in_progress for >10min`, { beatId });
    }

    return {
      summary: `CEO governance beat: budget=${budgetPct.toFixed(0)}%, stale=${staleTasks.length}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0, completed: true,
    };
  }

  // For specialist roles, delegate to existing executeSpecialistTask
  if (["tester", "ui_designer", "marketing", "skills_lead"].includes(role)) {
    emitEmployeeActivity(role, "decision", `Beat ${beatId}: routing to specialist executor`, { beatId, taskId });
    try {
      await executeSpecialistTask(taskId);
      const updated = getSnapshot().tasks.find((t) => t.id === taskId);
      return {
        summary: updated?.title || `${role} completed ${task.title}`,
        tokensUsed: drainBeatTokenAccumulator(beatId),
        actionsCount: 1,
        toolCalls: 1,
        completed: updated?.status === "completed",
      };
    } catch (err) {
      return {
        summary: `${role} task failed: ${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false,
      };
    }
  }

  // For CTO/PM/developer — run a single prompt cycle via runPromptText
  const soul = getRoleSoul(role);

  // For developer beats, ensure workspace is scaffolded before first prompt.
  // The scaffold is idempotent — skips if already set up.
  let preSnapshot: Map<string, number> | null = null;
  if (role === "developer") {
    const scaffoldResult = await scaffoldProductWorkspace(productDir, "product-app");
    if (scaffoldResult.scaffolded) {
      emitEmployeeActivity("developer", "info", `Beat ${beatId}: workspace scaffolded (Vite + React + Tailwind + shadcn/ui)`, { beatId, taskId });
    } else if (scaffoldResult.error) {
      emitEmployeeActivity("developer", "info", `Beat ${beatId}: scaffold skipped/partial: ${scaffoldResult.error}`, { beatId, taskId });
    }
    preSnapshot = await collectWorkspaceSnapshot();
  }
  const existingFileList = preSnapshot ? Array.from(preSnapshot.keys()).sort() : undefined;
  const taskPrompt = role === "developer" ? buildDeveloperBeatPrompt(task, existingFileList) : buildSpecialistTaskPrompt(task);
  const roleTools = getToolsForPrompt(role);

  // ── Governance pre-filter (Spec 13 Step 7) ──────────────────
  const trustScore = await cpLoadTrustScore(ctx.agentId);
  const roleToolNames = roleTools ? Object.keys(roleTools).filter(k => (roleTools as any)[k]) : [];
  const filterResult = filterToolsForAgent(
    role, trustScore.score, roleToolNames, BASE_POLICY_RULES,
    snapshot.company.id, ctx.agentId, beatId,
  );
  const governedToolsParam = toOpenCodeToolsParam(filterResult);
  // TODO: Re-enable governance tool filtering once trust calibration is tuned.
  // For now, use raw role tools so developers aren't blocked by low initial trust.
  // When governance is bypassed, also skip escalation approvals to avoid confusing
  // "Board approval required" banners for tools that are already allowed.
  const GOVERNANCE_ENABLED = false;
  const tools = GOVERNANCE_ENABLED ? governedToolsParam : roleTools;
  const filterSummary = summarizeFilterResult(filterResult, role);
  emitEmployeeActivity(role, "decision", `Beat ${beatId}: governance pre-filter — ${filterSummary}`, {
    beatId, taskId, detail: {
      trustScore: trustScore.score,
      trustTier: getTrustTier(trustScore.score),
      roleToolNames,
      allowed: filterResult.allowed,
      denied: filterResult.denied.map(d => d.tool),
      escalated: filterResult.escalated.map(e => e.tool),
      governanceBypassed: !GOVERNANCE_ENABLED,
    },
  });

  // ── Governance escalation (Spec 13 Step 9) ──────────────
  if (GOVERNANCE_ENABLED && filterResult.escalated.length > 0) {
    const escalatedTools = filterResult.escalated.map(e => e.tool);
    const escalationReasons = filterResult.escalated.map(e => `${e.tool}: ${e.decision.reason}`).join("; ");
    emitEmployeeActivity(role, "decision", `Beat ${beatId}: escalation required for tools [${escalatedTools.join(", ")}]`, {
      beatId, taskId, detail: { escalatedTools, reasons: escalationReasons },
    });
    upsertApproval({
      id: `gov-esc-${beatId}-${Date.now()}`,
      companyId: snapshot.company.id,
      type: "tool_governance",
      requestedByAgentId: ctx.agentId,
      status: "pending",
      title: `Tool escalation: ${escalatedTools.join(", ")}`,
      description: `Agent ${role} (trust=${trustScore.score.toFixed(2)}, tier=${filterResult.tier}) requests access to tools: ${escalationReasons}`,
      meetingId: null,
      agendaItemId: null,
      resolutionSummary: null,
    });
    auditAgent(snapshot.company.id, role, "tool_escalation", `Governance escalation: ${escalatedTools.join(", ")} (trust=${trustScore.score.toFixed(2)})`, {
      detail: { escalatedTools, trustScore: trustScore.score, tier: filterResult.tier, beatId },
      correlationId: taskId,
      severity: "warn",
    });
  }

  let beatViolationCount = 0;
  let beatSession: import("@opencode-ai/sdk").Session | null = null;
  const beatAgentState = agentSessions.get(role);
  let previousSessionId: string | undefined;

  emitEmployeeActivity(role, "context", `Beat ${beatId}: prompt constructed (${taskPrompt.length} chars), tools=${tools ? Object.keys(tools).filter(k => (tools as any)[k]).join(",") : "none"}`, {
    beatId, taskId, detail: { promptLength: taskPrompt.length, tools: tools ? Object.keys(tools).filter(k => (tools as any)[k]) : [], promptType: role === "developer" ? "developer_build" : "specialist_text" },
  });

  try {
    // Use ephemeral per-beat session to avoid context bleed (Spec 12 Phase 4)
    beatSession = await createBeatSession(role, beatId);
    emitEmployeeActivity(role, "context", `Beat ${beatId}: session created ${beatSession.id}`, { beatId, detail: { sessionId: beatSession.id } });
    // Update agentSessions so the SSE event bridge can resolve this beat session's
    // events (session.idle, message.part.updated, etc.) back to the correct role.
    previousSessionId = beatAgentState?.sessionId;
    if (beatAgentState) beatAgentState.sessionId = beatSession.id;
    touchAgentSession(role, "working");
    setTaskStatus(task.id, "in_progress");
    emitEmployeeActivity(role, "working", `Beat ${beatId}: executing "${task.title}"`, { taskId, beatId });

    emitEmployeeActivity(role, "prompt", `Beat ${beatId}: sending prompt to OpenCode (model=${ensureDeployment("workerDeployment")})`, {
      beatId, taskId, detail: { model: ensureDeployment("workerDeployment"), sessionId: beatSession.id },
    });
    const output = await runPromptText(role, beatSession.id, soul.systemPrompt + getAgentSkills(role), taskPrompt, tools);

    touchAgentSession(role, "idle");

    const tokensUsed = drainBeatTokenAccumulator(beatId);
    emitEmployeeActivity(role, "context", `Beat ${beatId}: prompt complete — ${tokensUsed} tokens, output=${(output?.length ?? 0)} chars`, {
      beatId, taskId, detail: { tokensUsed, outputLength: output?.length ?? 0, outputPreview: output?.slice(0, 200) },
    });

    // ── Post-execution: create artifacts & detect file changes ──
    const commitArtifactIds: string[] = [];
    let filesModified: string[] = [];

    if (role === "developer" && preSnapshot) {
      // Diff workspace to detect which files were actually changed
      const postSnapshot = await collectWorkspaceSnapshot();
      const changed: string[] = [];
      for (const [file, mtime] of postSnapshot) {
        const prevMtime = preSnapshot.get(file);
        if (prevMtime === undefined || prevMtime !== mtime) {
          changed.push(file);
        }
      }
      filesModified = changed;

      if (changed.length > 0) {
        // Filter to meaningful source files — config-only or lock-file-only changes don't count
        const meaningfulExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".css", ".scss", ".html"]);
        const meaningfulChanges = changed.filter((f) => {
          const ext = f.slice(f.lastIndexOf("."));
          return meaningfulExtensions.has(ext);
        });

        for (const f of changed) {
          appendTaskResult(task.id, `edited:${f}`);
        }
        emitEmployeeActivity(role, "context", `Beat ${beatId}: ${changed.length} file(s) modified (${meaningfulChanges.length} source): ${changed.slice(0, 10).join(", ")}`, {
          beatId, taskId, detail: { filesModified: changed, meaningfulCount: meaningfulChanges.length },
        });

        // If ONLY non-source files changed (e.g. just package-lock.json or opencode.json), don't complete
        if (meaningfulChanges.length === 0) {
          emitEmployeeActivity(role, "info", `Beat ${beatId}: developer changed ${changed.length} file(s) but none are source code — task stays in_progress`, { beatId, taskId });
          appendTaskResult(task.id, `[${beatId}] only config/lock files changed — no source code written`);
          return {
            summary: `Developer beat changed ${changed.length} config files but no source code — task stays in_progress for retry`,
            tokensUsed,
            actionsCount: 1,
            toolCalls: 1,
            completed: false,
          };
        }
      } else {
        // Developer produced no file changes — do NOT mark as completed.
        // Leave as in_progress so the next beat can retry with fresh context.
        emitEmployeeActivity(role, "info", `Beat ${beatId}: developer produced NO file changes — task stays in_progress`, { beatId, taskId });
        appendTaskResult(task.id, `[${beatId}] no files changed`);
        // Still update trust and return, but skip cpCommitTaskResult
        const noChangeEvent = buildTrustEvent(ctx.agentId, "task_failed", `Beat ${beatId}: no files written`, new Date().toISOString());
        cpUpdateTrustScore(noChangeEvent).catch(() => {});
        return {
          summary: `Developer beat produced no file changes — task stays in_progress for retry`,
          tokensUsed,
          actionsCount: 1,
          toolCalls: 1,
          completed: false,
        };
      }
    } else if ((role === "cto" || role === "pm") && output) {
      // CTO and PM produce text artifacts that downstream tasks consume
      const artifactKind: Artifact["kind"] = task.kind === "technical_plan" ? "plan"
        : task.kind === "acceptance_spec" ? "specification"
        : "output";
      const artifactTitle = task.kind === "technical_plan" ? "Technical Implementation Plan"
        : task.kind === "acceptance_spec" ? "Delivery Specification & Acceptance Criteria"
        : `${task.title} Output`;
      const artifact = addArtifact(role, artifactKind, artifactTitle, output);
      attachArtifactToTask(task.id, artifact.id);
      commitArtifactIds.push(artifact.id);
      appendTaskResult(task.id, `artifact:${artifact.id}`);
      emitEmployeeActivity(role, "context", `Beat ${beatId}: created artifact ${artifact.id} (${artifactTitle})`, {
        beatId, taskId, detail: { artifactId: artifact.id, artifactKind },
      });
    }

    // Commit task result — only if not already completed by a sub-handler
    const updated = getSnapshot().tasks.find((t) => t.id === taskId);
    if (updated && updated.status !== "completed") {
      cpCommitTaskResult(snapshot.company.id, task.id, {
        summary: output?.slice(0, 300) || `${role} completed ${task.title} via beat ${beatId}`,
        artifacts: commitArtifactIds,
        filesModified,
        tokensUsed,
        beatId,
      });
    }

    // Auto-preview: after developer beats, try to start/refresh the preview
    if (role === "developer") {
      emitEmployeeActivity("system", "preview", `Beat ${beatId}: developer task done — checking auto-preview`, { beatId });
      tryAutoPreview().catch(() => {});
    }

    // ── Governance: trust lifecycle — success (Spec 13 Step 10) ──
    const completionEvent = buildTrustEvent(ctx.agentId, "task_completed", `Beat ${beatId}: ${task.title}`, new Date().toISOString());
    await cpUpdateTrustScore(completionEvent);
    if (beatViolationCount === 0) {
      const complianceEvent = buildTrustEvent(ctx.agentId, "manual_adjustment", `Beat ${beatId}: clean beat compliance bonus`, new Date().toISOString(), TRUST_CONFIG.complianceBonus);
      await cpUpdateTrustScore(complianceEvent);
    }
    emitEmployeeActivity(role, "decision", `Beat ${beatId}: trust lifecycle updated — task_completed${beatViolationCount === 0 ? " + compliance_bonus" : ""} (violations=${beatViolationCount})`, {
      beatId, taskId, detail: { beatViolationCount },
    });

    return {
      summary: output?.slice(0, 500) || `${role} worked on ${task.title}`,
      tokensUsed,
      actionsCount: 1,
      toolCalls: 1,
      completed: true,
    };
  } catch (err) {
    touchAgentSession(role, "idle");
    emitEmployeeActivity(role, "error", `Beat ${beatId}: execution failed — ${err instanceof Error ? err.message : String(err)}`, {
      beatId, taskId, detail: { error: err instanceof Error ? err.message : String(err) },
    });

    // ── Governance: trust lifecycle — failure (Spec 13 Step 10) ──
    const failEvent = buildTrustEvent(ctx.agentId, "task_failed", `Beat ${beatId}: ${err instanceof Error ? err.message : "unknown error"}`, new Date().toISOString());
    cpUpdateTrustScore(failEvent).catch(() => {});

    return {
      summary: `Beat task execution failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false,
    };
  } finally {
    // Restore the persistent session ID so the event bridge tracks the correct session
    if (previousSessionId && beatAgentState) {
      beatAgentState.sessionId = previousSessionId;
    }
    // Destroy ephemeral session — best-effort cleanup (Spec 12 Phase 4 Step 5)
    if (beatSession) {
      destroyBeatSession(beatSession.id).catch(() => {});
    }
  }
}

/**
 * Trigger the CEO to propose the next sprint (exposed for beat context).
 */
export const triggerCeoSprintProposalFromBeat = () => triggerCeoSprintProposal();

/**
 * Execute a checklist-driven action when no task exists.
 * Routes by role: CEO proposes sprints, CTO/PM/others run LLM prompts.
 * Called by BeatDependencies.executeChecklistAction().
 */
export async function executeChecklistAction(
  ctx: import("@arceus/contracts").AgentBeatContext,
  action: { detail: string; suggestedAction: string },
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  const role = ctx.role;

  // Ensure the SSE event bridge is running so runPromptText() completion
  // promises resolve (session.idle / session.error events).
  if (!eventBridgeStarted) {
    startEventBridge().catch(() => {});
    eventBridgeStarted = true;
  }

  emitEmployeeActivity(role, "decision", `Beat ${beatId}: checklist action dispatched — "${action.suggestedAction}"`, {
    beatId, detail: { suggestedAction: action.suggestedAction, actionDetail: action.detail },
  });

  // ── CEO: propose sprint when none exists ──
  if (role === "ceo" && action.suggestedAction.toLowerCase().includes("sprint")) {
    if (isCeoStreaming()) {
      emitEmployeeActivity("ceo", "info", `Beat ${beatId}: CEO skipped — live chat streaming`, { beatId });
      return { summary: "CEO skipped — live chat streaming in progress", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }
    try {
      emitEmployeeActivity("ceo", "working", `Beat ${beatId}: CEO proposing sprint — ${action.suggestedAction}`, { beatId });
      await triggerCeoSprintProposal();
      emitEmployeeActivity("ceo", "transition", `Beat ${beatId}: CEO sprint proposal completed`, { beatId });
      return {
        summary: `CEO triggered sprint proposal: ${action.suggestedAction}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
      };
    } catch (err) {
      emitEmployeeActivity("ceo", "error", `Beat ${beatId}: CEO sprint proposal failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
      return {
        summary: `CEO sprint proposal failed: ${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
      };
    }
  }

  // ── CTO: sprint escalation review (Spec 21) ──
  if (role === "cto" && action.suggestedAction === "sprint_review:cto_escalation_review") {
    return executeCtoBeatEscalationReview(ctx, beatId);
  }

  // ── PM: scope triage, board response ──
  if (role === "pm" || role === "cto") {
    try {
      const snapshot = getSnapshot();
      const soul = getRoleSoul(role);
      const session = await ensureAgentSession(snapshot, role);
      touchAgentSession(role, "working");
      emitEmployeeActivity(role, "working", `Beat ${beatId}: ${action.suggestedAction}`, { beatId });

      const prompt = `You are the ${role.toUpperCase()}. Current situation: ${action.detail}. Action needed: ${action.suggestedAction}. Analyze and take the appropriate action. Respond with a structured summary of what you did.`;
      emitEmployeeActivity(role, "prompt", `Beat ${beatId}: sending checklist-action prompt (${prompt.length} chars)`, { beatId, detail: { promptLength: prompt.length } });
      const output = await runPromptText(role, session.sessionId, soul.systemPrompt + getAgentSkills(role), prompt);
      touchAgentSession(role, "idle");

      emitEmployeeActivity(role, "context", `Beat ${beatId}: checklist action completed — output=${(output?.length ?? 0)} chars`, {
        beatId, detail: { outputLength: output?.length ?? 0, outputPreview: output?.slice(0, 200) },
      });
      return {
        summary: output?.slice(0, 500) || `${role} completed: ${action.suggestedAction}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
      };
    } catch (err) {
      touchAgentSession(role, "idle");
      emitEmployeeActivity(role, "error", `Beat ${beatId}: ${role} checklist action failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
      return {
        summary: `${role} checklist action failed: ${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
      };
    }
  }

  // ── Tester: sprint review actions (Spec 21) ──
  if (role === "tester" && action.suggestedAction.startsWith("sprint_review:")) {
    startBeatTokenAccumulator(beatId);
    const reviewAction = action.suggestedAction;

    if (reviewAction === "sprint_review:run_tester_verification") {
      return executeSprintReviewVerification(ctx, beatId);
    }
    if (reviewAction === "sprint_review:run_final_gate") {
      return executeSprintFinalGate(ctx, beatId);
    }
    if (reviewAction === "sprint_review:retest_after_rework") {
      return executeRetestAfterRework(ctx, beatId);
    }

    return {
      summary: `Unknown sprint review action: ${reviewAction}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }

  // ── Fallback: log the action without executing ──
  emitEmployeeActivity(role, "info", `Beat ${beatId}: no handler for checklist action — "${action.suggestedAction}"`, { beatId });
  return {
    summary: `${role}: ${action.suggestedAction} (no handler)`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
  };
}
