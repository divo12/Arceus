import type { AgentIdentity, CompanySnapshot } from "@arceus/contracts";
import { getAgentByRole, nowIso } from "@arceus/task-engine";
import { getRoleSoul } from "@arceus/company-runtime";
import { getOpencode, resetOpencodeConnection, createBeatSession, destroyBeatSession } from "../infra/opencode.js";
import { ensureDeployment } from "../config/index.js";
import { getSnapshot } from "../persistence/store.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { describePgError } from "../infra/pg-errors.js";
import { withRetry, isRetryableError } from "../infra/resilience.js";
import { truncateTelemetry } from "../infra/utils.js";
import { agentSessions, pendingPromptCompletions, type AgentSessionState } from "../orchestration/state.js";
import { updateAgentSessionState } from "../agents/sessions.js";
import { formatHippocampusContext } from "../memory/operations.js";
import { hippocampus } from "../memory/extractors.js";
import { buildSkillSection } from "../skills/catalog.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent session management
// ─────────────────────────────────────────────────────────────────────────────

/** Create a new OpenCode session for an agent and register it in the session map. */
export async function createAgentSession(agent: AgentIdentity): Promise<AgentSessionState> {
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

/** Ensure an agent has an active session, creating one if needed. */
export async function ensureAgentSession(snapshot: CompanySnapshot, role: AgentIdentity["role"]) {
  const existing = agentSessions.get(role);
  if (existing) return existing;

  const agent = getAgentByRole(snapshot, role);
  if (!agent) throw new Error(`${role.toUpperCase()} agent not available`);

  return createAgentSession(agent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt completion tracking (SSE-driven resolve + polling fallback)
// ─────────────────────────────────────────────────────────────────────────────

let promptCompletionPollerHandle: NodeJS.Timeout | null = null;
const PROMPT_COMPLETION_POLL_INTERVAL_MS = 8_000;

/** Register a pending prompt completion with a timeout. Resolves when the session goes idle. */
export function registerPromptCompletion(sessionId: string, timeoutMs = 5 * 60 * 1000): Promise<void> {
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
    startPromptCompletionPoller();
  });
}

/** Resolve a pending prompt completion for a session. */
export function resolvePromptCompletion(sessionId: string) {
  const entry = pendingPromptCompletions.get(sessionId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingPromptCompletions.delete(sessionId);
    entry.resolve();
  }
}

/** Reject a pending prompt completion for a session with an error. */
export function rejectPromptCompletion(sessionId: string, error: Error) {
  const entry = pendingPromptCompletions.get(sessionId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingPromptCompletions.delete(sessionId);
    entry.reject(error);
  }
}

function startPromptCompletionPoller() {
  if (promptCompletionPollerHandle) return;
  promptCompletionPollerHandle = setInterval(() => {
    void pollPendingPromptCompletions();
  }, PROMPT_COMPLETION_POLL_INTERVAL_MS);
}

/** Stop the background poller that checks for stalled prompt completions. */
export function stopPromptCompletionPoller() {
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
        try {
          const messagesResult = await opencode.client.session.messages({ path: { id: sessionId } });
          const messages = messagesResult.data as Array<{ info: any }> | undefined;
          const hasAssistant = messages?.some((m) => m.info?.role === "assistant");
          if (hasAssistant) {
            emitEmployeeActivity("system", "info", `Polling fallback: session ${sessionId.slice(0, 12)}… not in status but has assistant response — resolving`);
            resolvePromptCompletion(sessionId);
          }
        } catch {
          emitEmployeeActivity("system", "info", `Polling fallback: session ${sessionId.slice(0, 12)}… unreachable — resolving to avoid stall`);
          resolvePromptCompletion(sessionId);
        }
      }
    }
  } catch {
    // Non-fatal — SSE bridge is the primary path; polling is best-effort
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runPromptText — send prompt to OpenCode session, wait for completion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a prompt to an agent's OpenCode session with enriched system prompt
 * (skills + hippocampus memory), wait for completion, and return the response text.
 */
export async function runPromptText(
  role: AgentIdentity["role"],
  sessionId: string,
  systemPrompt: string,
  text: string,
  tools?: Record<string, boolean>,
  matchedSkillIds?: string[],
) {
  const deployment = ensureDeployment("workerDeployment");

  const skillSection = buildSkillSection(role, matchedSkillIds);

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

  const enrichedSystemPrompt = [systemPrompt, skillSection, memoryBlock].filter(Boolean).join("\n");

  emitEmployeeActivity(role, "context", `Prompt assembled: system=${systemPrompt.length}ch skills=${skillSection.length}ch memory=${memoryBlock.length}ch (${memoryCount} facts, ${habitCount} habits) → total=${enrichedSystemPrompt.length}ch`, {
    detail: {
      systemPromptLen: systemPrompt.length,
      skillSectionLen: skillSection.length,
      matchedSkillCount: matchedSkillIds?.length ?? 0,
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

      const completionPromise = registerPromptCompletion(currentSessionId);

      // Fire-and-forget: session.prompt() may block until LLM completes inside
      // OpenCode.  We detect completion via SSE session.idle (primary) or the
      // polling fallback — both feed into completionPromise.
      opencode.client.session.prompt({
        path: { id: currentSessionId },
        body: promptBody as any,
      }).catch((err: unknown) => {
        rejectPromptCompletion(
          currentSessionId,
          err instanceof Error ? err : new Error(String(err)),
        );
      });

      await completionPromise;

      const messagesResult = await opencode.client.session.messages({
        path: { id: currentSessionId },
      });

      const messages = messagesResult.data as Array<{ info: any; parts: Array<{ type: string; text?: string }> }> | undefined;
      if (!messages || messages.length === 0) {
        return "";
      }

      const assistantMessages = messages.filter((m) => m.info?.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      if (!lastAssistant) return "";

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
