import type { AgentIdentity, CompanySnapshot } from "@arceus/contracts";
import type { Message, Part, SessionPromptData } from "@opencode-ai/sdk";

/** Element shape of `client.session.messages({...}).data` per OpenCode SDK. */
interface SessionMessage { info: Message; parts: Part[] }

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
import { agentSessions, pendingPromptCompletions, agentSessionKey, type AgentSessionState } from "../orchestration/state.js";
import { getSessionContext } from "../orchestration/session-context.js";
import { updateAgentSessionState } from "../agents/sessions.js";
import { formatHippocampusContext } from "../memory/operations.js";
import { hippocampus } from "../memory/extractors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent session management
// ─────────────────────────────────────────────────────────────────────────────

/** Create a new OpenCode session for an agent and register it in the session map. */
async function createAgentSession(agent: AgentIdentity, companyId: string): Promise<AgentSessionState> {
  const soul = getRoleSoul(agent.role);
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

  agentSessions.set(agentSessionKey(companyId, agent.role), state);
  emitEmployeeActivity(agent.role, "info", `Session created for ${agent.name} (${agent.title})`);
  return state;
}

/** Ensure an agent has an active session, creating one if needed. */
export async function ensureAgentSession(snapshot: CompanySnapshot, role: AgentIdentity["role"], companyId: string) {
  const existing = agentSessions.get(agentSessionKey(companyId, role));
  if (existing) return existing;

  const agent = getAgentByRole(snapshot, role);
  if (!agent) throw new Error(`${role.toUpperCase()} agent not available`);

  return createAgentSession(agent, companyId);
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

/**
 * If no SSE activity is seen for a pending session within this window, the
 * poller rejects it early rather than waiting for the full hard cap.
 *
 * Iteration log:
 *   4 min — original eb44642 default
 *   6 min — bumped after observing single Azure round-trips >4 min
 *  10 min — current. Three production stalls (beats 9/12/17) all fired
 *           at exactly beat-start + 6 min regardless of intervening
 *           tool activity, suggesting the lastActivityAt reset hook in
 *           event-bridge.ts isn't firing for arceus tool events. Until
 *           that's fixed, this constant acts as a hard total-beat budget.
 *           10 min covers most legitimate dev work (build + test + a few
 *           LLM iterations) while still being well under the 15-min
 *           HARD_CAP_MS so genuinely dead sessions still fail fast.
 */
const BEAT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * No-tool-invoked early-exit deadline. If the LLM has been thinking for
 * this long with ZERO MCP tool calls, the beat is producing prose instead
 * of action — abort early instead of letting the prompt run to completion
 * and burn a full Azure round-trip.
 *
 * Tracked via `toolCallCount` on the pending entry, incremented by the
 * MCP middleware. The 10-min stall guard above stays as the final floor
 * for legitimate long beats with productive work.
 *
 * 90s is generous: even a slow Azure round-trip with reasoning tokens
 * usually streams its first tool call within 30-45s. A beat that has
 * been silent on the MCP path past 90s is "thinking but not acting."
 */
const NO_TOOL_INVOKED_DEADLINE_MS = 90 * 1000;

/**
 * Read-loop threshold. If the agent fires this many consecutive built-in
 * `read` calls without any "action" tool firing in between (task_claim,
 * artifact_create, task_complete, etc.), the beat is in a context-
 * gathering loop and will not progress. Reject early with cause
 * `read_loop` instead of letting it burn HARD_CAP_MS.
 *
 * Counter is `readsSinceAction` on the pending entry — bumped by the
 * watchdog-reset endpoint on `tool === "read"`, reset by the MCP
 * middleware on action tools. 20 is generous: a legitimate page-by-page
 * read of a large file uses ~5 calls; 20 is the gpt-5.4-mini pathology
 * threshold where the model is iterating offsets one line at a time.
 */
const READ_LOOP_THRESHOLD = 20;

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
    const now = Date.now();
    pendingPromptCompletions.set(sessionId, {
      resolve,
      reject,
      timer,
      startedAt: now,
      lastActivityAt: now,
      toolCallCount: 0,
      readsSinceAction: 0,
    });
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

/**
 * Cancel all in-flight beat completions for a given company. Walks the
 * session-context registry to find sessions belonging to the company,
 * then rejects each pending completion. Used when the active company
 * switches (e.g. user resets and bootstraps a new company) so the old
 * company's beats don't keep holding the global concurrency semaphore
 * and starve the new company's heartbeat.
 *
 * Best-effort and synchronous-ish — rejections fire immediately; the
 * run-beat finally block handles claim release + audit cleanup.
 *
 * Returns the count of sessions that were cancelled (for logging).
 */
export function cancelInFlightBeatsForCompany(companyId: string): number {
  let cancelled = 0;
  // Snapshot keys first — rejectPromptCompletion mutates the map mid-iteration.
  const sessionIds = [...pendingPromptCompletions.keys()];
  for (const sessionId of sessionIds) {
    const ctx = getSessionContext(sessionId);
    if (ctx?.companyId === companyId) {
      rejectPromptCompletion(
        sessionId,
        new Error(`Beat cancelled: active company switched away from ${companyId}`),
      );
      cancelled += 1;
    }
  }
  return cancelled;
}

function startPromptCompletionPoller() {
  if (promptCompletionPollerHandle) return;
  promptCompletionPollerHandle = setInterval(() => {
    void pollPendingPromptCompletions();
  }, PROMPT_COMPLETION_POLL_INTERVAL_MS);
}


async function pollPendingPromptCompletions() {
  if (pendingPromptCompletions.size === 0) return;

  try {
    const opencode = await getOpencode();
    const statusResult = await opencode.client.session.status({});
    const statusMap = statusResult.data as Record<string, { type: string }> | undefined;
    if (!statusMap) return;

    for (const [sessionId, entry] of pendingPromptCompletions) {
      // Stall guard: if no SSE event has touched this session in BEAT_STALL_TIMEOUT_MS,
      // the agent is silently hung. Reject early so the beat fails fast instead of
      // burning the full 15-min hard cap.
      if (Date.now() - entry.lastActivityAt > BEAT_STALL_TIMEOUT_MS) {
        emitEmployeeActivity("system", "info", `Stall detected: session ${sessionId.slice(0, 12)}… silent for ${BEAT_STALL_TIMEOUT_MS / 1000}s — rejecting`);
        rejectPromptCompletion(sessionId, new Error(`Beat session ${sessionId} stalled: no SSE activity for ${BEAT_STALL_TIMEOUT_MS}ms`));
        continue;
      }

      // Layer B no-tool-invoked early-exit: the LLM has been "thinking" past
      // NO_TOOL_INVOKED_DEADLINE_MS without making a single tool call. That's
      // a behavioral failure — the model is producing prose instead of action.
      // Beats like this would otherwise burn the full Azure round-trip (we've
      // seen 6+ minute "no_tool_invoked" beats). Abort early so the role can
      // get re-dispatched on its next interval.
      if (entry.toolCallCount === 0 && Date.now() - entry.startedAt > NO_TOOL_INVOKED_DEADLINE_MS) {
        emitEmployeeActivity(
          "system",
          "info",
          `No-tool deadline: session ${sessionId.slice(0, 12)}… ${Math.round((Date.now() - entry.startedAt) / 1000)}s without a tool call — rejecting`,
        );
        rejectPromptCompletion(
          sessionId,
          new Error(`Beat session ${sessionId} produced no tool calls within ${NO_TOOL_INVOKED_DEADLINE_MS}ms`),
        );
        continue;
      }

      // Layer C read-loop guard: the agent has fired READ_LOOP_THRESHOLD
      // consecutive `read` calls without any action tool resetting the
      // counter. The pathology: gpt-5.4-mini iterating offsets one line
      // at a time over a SKILL.md file the `skill()` tool already loaded
      // (observed in beat_4_1778410838848 — 54 consecutive reads, 0
      // artifact_create, 0 task_complete, ended in failure after 2:51).
      // Reject with cause `read_loop` so the orchestrator surfaces the
      // pattern instead of letting it burn HARD_CAP_MS.
      if (entry.readsSinceAction >= READ_LOOP_THRESHOLD) {
        emitEmployeeActivity(
          "system",
          "info",
          `Read-loop: session ${sessionId.slice(0, 12)}… ${entry.readsSinceAction} consecutive reads w/o action — rejecting`,
        );
        rejectPromptCompletion(
          sessionId,
          new Error(`Beat session ${sessionId} hit read_loop: ${entry.readsSinceAction} consecutive read calls without an action tool firing`),
        );
        continue;
      }

      const sessionStatus = statusMap[sessionId];
      if (sessionStatus?.type === "idle") {
        emitEmployeeActivity("system", "info", `Polling fallback: session ${sessionId.slice(0, 12)}… is idle — resolving completion`);
        resolvePromptCompletion(sessionId);
      } else if (!sessionStatus) {
        try {
          const messagesResult = await opencode.client.session.messages({ path: { id: sessionId } });
          const messages = messagesResult.data;
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
  companyId?: string,
) {
  const deployment = ensureDeployment("workerDeployment");
  const sessionKey = companyId ? agentSessionKey(companyId, role) : role;

  let memoryBlock = "";
  let memoryCount = 0;
  let habitCount = 0;
  try {
    // Spec 31 Phase 7.B.1 / 7.C.c — read agent from canonical via repo.
    // Prefer explicitly passed companyId; fall back to the global seam for
    // backward compatibility with internal paths that don't yet thread it.
    const resolvedCompanyId = companyId ?? getActiveCompanyId();
    const agent = resolvedCompanyId
      ? await agentsRepo.findAgentByRole(getDb(), resolvedCompanyId, role)
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

  updateAgentSessionState(sessionKey, {
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

      const messages = messagesResult.data;
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
        await resetOpencodeConnection();
        agentSessions.delete(sessionKey);
        emitEmployeeActivity(role, "info", `OpenCode connection lost — reconnecting (attempt ${attempt})…`);
        // Spec 31 Phase 7.C.c — canonical-backed view for the retry path.
        const retryCompanyId = companyId ?? getActiveCompanyId();
        if (!retryCompanyId) return;
        const snap = await buildSnapshotView(retryCompanyId);
        const freshSession = await ensureAgentSession(snap, role, retryCompanyId);
        currentSessionId = freshSession.sessionId;
      },
    },
  );

  updateAgentSessionState(sessionKey, {
    promptCompletedAt: nowIso(),
    lastProgressAt: nowIso(),
    lastEventSummary: truncateTelemetry(output || "Prompt completed with no text output."),
    awaiting: "idle",
  });

  return output;
}
