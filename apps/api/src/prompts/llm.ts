import type { AgentIdentity, CompanySnapshot } from "@arceus/contracts";
import type { Message, Part, SessionPromptData } from "@opencode-ai/sdk";

/** Element shape of `client.session.messages({...}).data` per OpenCode SDK. */
type SessionMessage = { info: Message; parts: Part[] };

/** The `body` we send to `client.session.prompt()`. Required = SessionPromptData["body"]. */
type SessionPromptBody = NonNullable<SessionPromptData["body"]>;
import { getAgentByRole, nowIso } from "@arceus/task-engine";
import { getRoleSoul } from "@arceus/company-runtime";
import { getOpencode, resetOpencodeConnection, createBeatSession, destroyBeatSession } from "../infra/opencode.js";
import { ensureDeployment } from "../config/index.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { describePgError } from "../infra/pg-errors.js";
import { withRetry, isRetryableError } from "../infra/resilience.js";
import { truncateTelemetry } from "../infra/utils.js";
import { agentSessions, pendingPromptCompletions, type AgentSessionState } from "../orchestration/state.js";
import { updateAgentSessionState } from "../agents/sessions.js";
import { formatHippocampusContext } from "../memory/operations.js";
import { hippocampus } from "../memory/extractors.js";

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
// Re-import the canonical value from orchestration/state so the two
// modules stay in lockstep (was a duplicate `8_000` literal — C17).
import { PROMPT_COMPLETION_POLL_INTERVAL_MS } from "../orchestration/state.js";

/**
 * Default ceiling on how long `registerPromptCompletion` waits before
 * rejecting. Mirrors the longest agent prompt timeout in the system —
 * keeping it as a named constant means callers that want a different
 * timeout pass it explicitly rather than leaving the magic 5min inline.
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/** Register a pending prompt completion with a timeout. Resolves when the session goes idle. */
export function registerPromptCompletion(sessionId: string, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS): Promise<void> {
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
          const messages = messagesResult.data as SessionMessage[] | undefined;
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
) {
  const deployment = ensureDeployment("workerDeployment");

  let memoryBlock = "";
  let memoryCount = 0;
  let habitCount = 0;
  try {
    // Spec 31 Phase 7.B.1 / 7.C.c — read agent from canonical via repo,
    // companyId via the seam helper.
    const companyId = getActiveCompanyId();
    const agent = companyId
      ? await agentsRepo.findAgentByRole(getDb(), companyId, role)
      : null;
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

  const enrichedSystemPrompt = [systemPrompt, memoryBlock].filter(Boolean).join("\n");

  emitEmployeeActivity(role, "context", `Prompt assembled: system=${systemPrompt.length}ch memory=${memoryBlock.length}ch (${memoryCount} facts, ${habitCount} habits) → total=${enrichedSystemPrompt.length}ch`, {
    detail: {
      systemPromptLen: systemPrompt.length,
      memoryBlockLen: memoryBlock.length,
      memoryCount,
      habitCount,
      totalPromptLen: enrichedSystemPrompt.length,
      userPromptLen: text.length,
      model: deployment,
      tools: tools ? Object.entries(tools).filter(([, enabled]) => enabled).map(([k]) => k) : [],
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
      const promptBody: SessionPromptBody = {
        model: { providerID: "azure", modelID: deployment },
        agent: role,
        system: enrichedSystemPrompt,
        parts: [{ type: "text", text }],
        ...(tools ? { tools } : {}),
      };

      const completionPromise = registerPromptCompletion(currentSessionId);

      // Fire-and-forget: session.prompt() may block until LLM completes inside
      // OpenCode.  We detect completion via SSE session.idle (primary) or the
      // polling fallback — both feed into completionPromise.
      opencode.client.session.prompt({
        path: { id: currentSessionId },
        body: promptBody,
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

      const messages = messagesResult.data as SessionMessage[] | undefined;
      if (!messages || messages.length === 0) {
        return "";
      }

      const assistantMessages = messages.filter(
        (m): m is { info: Extract<Message, { role: "assistant" }>; parts: Part[] } =>
          m.info?.role === "assistant",
      );
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      if (!lastAssistant) return "";

      const infoError = lastAssistant.info.error;
      if (infoError) {
        const errorMsg =
          ("data" in infoError && typeof infoError.data === "object" && infoError.data !== null && "message" in infoError.data
            ? String((infoError.data as { message?: unknown }).message)
            : undefined) ??
          infoError.name ??
          "Unknown OpenCode session error";
        throw new Error(`OpenCode ${role} session error: ${errorMsg}`);
      }

      return (
        lastAssistant.parts
          ?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
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
        // Spec 31 Phase 7.C.c — canonical-backed view for the retry path.
        const retryCompanyId = getActiveCompanyId();
        if (!retryCompanyId) return;
        const snap = await buildSnapshotView(retryCompanyId);
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
