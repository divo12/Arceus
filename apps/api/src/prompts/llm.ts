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
import { swallowAndAudit, swallowAndReport } from "../observability/swallow.js";
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
 *  10 min — bumped because the lastActivityAt reset hook in
 *           event-bridge.ts wasn't firing for arceus tool events.
 *           Acted as a hard total-beat budget while the bump was
 *           unreliable.
 *   3 min — current. d34f15e made the MCP middleware reliably bump
 *           lastActivityAt on every arceus_* call (x-session-id is
 *           now always sent + resolved tier-1). With reliable
 *           bumping, 3 min of TOTAL silence — no tool calls, no SSE
 *           tokens, no reasoning — means the agent is genuinely
 *           hung. Healthy beats stream reasoning + tool calls
 *           continuously and never let lastActivityAt drift this
 *           far. Cuts the 10-min stall delay observed in
 *           beat_7_1778460613003 (last tool 00:50:44 → stall fired
 *           01:00:44, 10 min of dead air) down to ~3 min.
 */
// 2026-06-11: 2min was KILLING HEALTHY BEATS. The ratchet-down to 2min
// assumed "healthy beats stream reasoning + tool calls continuously" —
// disproven in PROD: gpt-5.2 on this resource streams ZERO reasoning
// deltas (0 agent.reasoning events across an entire day; summaries are
// not requested, so the SSE stream is dark for the whole think phase),
// and its reasoning windows between tool batches routinely exceed 2min
// on developer-sized contexts. Every post-guard developer beat died at
// exactly ~120s after its last tool call (beats 14-16, 18, 19 of
// 2026-06-11) while Azure quota sat at 15M TPM with 99.9% headroom —
// i.e. the model was thinking, not hung. Azure's own guidance for
// reasoning models: tolerate >=300s of stream silence.
//
// 2026-06-11 evening: 5min → 150s, justified by two verified facts.
// (1) reasoningSummary:"auto" is live and works — 90 minutes of beats
// with ZERO silence-stalls (previously 5-10 per 90min); summary deltas
// stream during thinking, so healthy inter-event gaps are ≤60s and
// 150s gives 2.5x headroom. (2) Research (plans/research-agent-stall-
// prevention.md): Azure's load balancer silently drops TCP flows idle
// ≥240s — no FIN/RST — so past 240s of silence the connection is
// PROVABLY dead; waiting 300s meant idling a full minute on a corpse.
// 150s lets the stall-nudge (abort + re-prompt, see STALL_NUDGE_LIMIT)
// recover a dropped flow twice as fast.
//
// If you ratchet this further down, FIRST verify reasoning deltas are
// streaming (agent.reasoning events / zero-stall telemetry) — silence
// is only a death signal when thinking is visible.
const BEAT_STALL_TIMEOUT_MS = 150 * 1000;

/**
 * Productive-action deadline. If a beat has been running this long
 * without any *progress-making* tool firing (task_claim, task_complete,
 * artifact_create, workspace_checkpoint, etc. — see
 * ACTION_TOOLS_RESETTING_READ_LOOP in mcp/middleware.ts), the beat is
 * stuck in a meta loop: task_get → task_append_plan_step → silence,
 * never committing real state.
 *
 * Distinct from NO_TOOL_INVOKED (which only checks count==0) and from
 * BEAT_STALL (which fires on total SSE silence). Catches the case where
 * the agent looks busy on the tool-call timeline but isn't actually
 * advancing the world.
 *
 * 4 minutes is generous — even a thoughtful pre-claim read sequence
 * should land a task_claim or task_block within that window. Beats
 * scored as no_productive_action get re-dispatched on the next role
 * interval with fresh context, often unsticking the pattern.
 */
// 2min was too aggressive — we observed a UI designer reaped 122s
// after a successful apply_patch (which IS productive work but wasn't
// classified as such — only arceus_* action tools counted, not
// built-in edit/write/apply_patch). Bumped to 3min and the classifier
// in beats.routes.ts now counts built-in mutating tools too. Trade-off
// of an extra minute is worth keeping legitimate work from getting
// killed on roles whose work is built-in file edits (developer,
// ui_designer, tester author).
const NO_PRODUCTIVE_ACTION_DEADLINE_MS = 3 * 60 * 1000;

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
// Lowered from 90s → 45s for fail-fast. A model that hasn't emitted ANY
// tool call within 45s is in a silent-stall (we observed totalTokens=0
// beats finishing this way at 90s). Kill it earlier and free the slot.
const NO_TOOL_INVOKED_DEADLINE_MS = 45 * 1000;

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
/**
 * Reasoning-stall ceiling. If a beat HAS made tool calls but its last tool
 * call completed more than this long ago, the model is streaming reasoning
 * (or prose) without acting. This is the gap none of the other guards cover:
 *
 *   • BEAT_STALL_TIMEOUT_MS never fires — reasoning-token deltas are SSE
 *     events and bump `lastActivityAt` (event-bridge.ts processEvent).
 *   • NO_TOOL_INVOKED_DEADLINE_MS never fires — it only checks
 *     `toolCallCount === 0`, i.e. before the FIRST tool call.
 *
 * Observed on gpt-5.2: developer beats stream reasoning for ~10 min after
 * a tool result, then die at the hard cap with all work discarded. With
 * this guard they die at 3 min with cause `reasoning_stall` and the role
 * re-dispatches with fresh context ~3× sooner.
 *
 * 2026-06-11: bumped 3min → 6min alongside the BEAT_STALL retune. The
 * 3-min value was premised on reasoning being VISIBLE (stream deltas
 * proving the model is alive while it thinks) — which is now true
 * (reasoningSummary streams), so 6min is the generous "streaming but
 * never acting" backstop: a model that thinks visibly for 6 straight
 * minutes without ONE tool call isn't converging. Sits between the
 * 150s silence window and the 15-min hard cap.
 */
const REASONING_STALL_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Grace ceiling for in-flight tool-call generation. While OpenCode reports
 * a tool part in state "pending" (the model is emitting arguments — e.g. a
 * multi-hundred-line apply_patch), the stream is event-silent BY DESIGN
 * (verified empirically: zero deltas during argument generation) even
 * though tokens are actively flowing from Azure. The silence guards must
 * stand down during that window or they abort working beats mid-patch.
 * The ceiling bounds the suppression: a "pending" part that never reaches
 * running/completed within this window means the generation genuinely
 * died, and the normal stall path resumes.
 */
const TOOL_ARG_STREAM_GRACE_MS = 6 * 60 * 1000;

/** True while the model is mid-tool-call emission (see TOOL_ARG_STREAM_GRACE_MS). */
function isToolArgStreaming(entry: { toolStreamingAt: number | null }): boolean {
  return entry.toolStreamingAt !== null && Date.now() - entry.toolStreamingAt < TOOL_ARG_STREAM_GRACE_MS;
}

// Effectively disabled. The original intent was to catch gpt-5.4-mini's
// "read one line at a time across 50 files" pathology. In practice it's
// firing on legitimate file inspection too (developer reading 20
// different source files to understand the codebase). Raised to 200 so
// it remains as a sanity ceiling for the pathological case but
// never fires on normal work. If you actually need a line-by-line read
// detector, do it via `limit < 10` heuristic, not raw count.
const READ_LOOP_THRESHOLD = 200;

/**
 * Stall-nudge recovery. When the SSE-silence guard trips, the first
 * response is NOT to reap the beat — it's to abort the hung in-flight
 * request and re-prompt the same session. The session keeps its full
 * message history, so recovery costs seconds instead of the ~6 min of
 * beat death + re-dispatch + cold-start context rebuild.
 *
 * Why this is the right shape for the hang class: a beat that produces
 * ZERO events for 5+ minutes while the deployment demonstrably streams
 * (direct Azure probe: 87 reasoning-summary deltas) is a hung HTTP
 * request, not a thinking model. Waiting longer cannot fix it; only a
 * fresh request can.
 *
 * One nudge per beat: the windows already consume the budget (stall at
 * 5 min + nudged window ≈ the 10-min hard cap). A session that hangs
 * twice in one beat gets reaped by the existing stall reject.
 */
const STALL_NUDGE_LIMIT = 1;

const STALL_NUDGE_TEXT =
  "[system recovery] Your previous request hung and was aborted. Your context and prior work are intact — do NOT re-read files or start over. " +
  "Continue exactly where you stopped: emit your next tool call now, or finish with task_complete / task_block (include evidence).";

/**
 * T-minus wrap-up nudge (SWE-agent's "autosubmit on budget death",
 * paperclip's status-update discipline). When a beat approaches its hard
 * cap, inject a user-role message telling the agent to checkpoint NOW —
 * finish the smallest shippable piece, task_complete/task_block with
 * evidence, and leave a plan step saying where it stopped. Converts
 * "guillotined mid-edit at the cap" (observed: 6 developer beats killed
 * at 10:00 before their serialize phase on 2026-06-11) into a clean,
 * scoreable ending.
 *
 * Only fires for sessions whose cap is large enough to be a beat
 * (WRAP_UP_MIN_CAP_MS filters out the 5-min chat prompts) and that have
 * a registered session context. Sent WITHOUT aborting — OpenCode queues
 * the message behind the in-flight step, so it lands between steps.
 */
const WRAP_UP_LEAD_MS = 2 * 60 * 1000;
const WRAP_UP_MIN_CAP_MS = 8 * 60 * 1000;
const WRAP_UP_TEXT =
  "[system] About 2 minutes remain in this beat before the hard cap. Stop exploring NOW. " +
  "Finish the smallest shippable piece, then call task_complete with evidence (or task_block with the reason), " +
  "and append a plan step saying exactly where you stopped so the next beat continues cleanly.";

/**
 * Sessions with a stall-nudge in flight. run-beat consults this so the
 * original prompt call's rejection (caused by our own abort) doesn't
 * fail the beat out from under the nudged attempt. Cleared when the
 * pending completion resolves or rejects.
 */
const activeNudges = new Set<string>();

/** True if a stall-nudge recovery currently owns this session. */
export function isNudgeActive(sessionId: string): boolean {
  return activeNudges.has(sessionId);
}

/** Abort the hung request and re-prompt the session to continue. */
async function nudgeStalledSession(sessionId: string): Promise<void> {
  const opencode = await getOpencode();
  // Abort first — a prompt queued behind a dead request never runs.
  // Best-effort: if the request already died server-side, abort 404s
  // and the re-prompt below still proceeds.
  await swallowAndReport(
    "beat.stall_nudge_abort",
    () => opencode.client.session.abort({ path: { id: sessionId } }),
    { detail: { sessionId } },
  );
  const ctx = getSessionContext(sessionId);
  const deployment = ensureDeployment("workerDeployment");
  await opencode.client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID: "azure", modelID: deployment },
      ...(ctx?.role ? { agent: ctx.role } : {}),
      parts: [{ type: "text", text: STALL_NUDGE_TEXT }],
    },
    // Bounded lifetime: this call blocks until the nudged response
    // completes. If the session dies anyway (second stall → reap →
    // destroyBeatSession), an unbounded fetch sits on an open socket to
    // the local opencode server until something severs the connection —
    // observed in PROD as a "fetch failed" zombie surfacing 26 minutes
    // after its beat was reaped. 6 min covers any legitimate nudged
    // response within the beat cap.
    signal: AbortSignal.timeout(6 * 60 * 1000),
  });
}

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
      lastProductiveActionAt: now,
      lastToolAt: now,
      toolCallCount: 0,
      readsSinceAction: 0,
      nudgeCount: 0,
      capMs: timeoutMs,
      wrapUpSent: false,
      toolStreamingAt: null,
    });
    startPromptCompletionPoller();
  });
}

/** Resolve a pending prompt completion for a session. */
export function resolvePromptCompletion(sessionId: string) {
  activeNudges.delete(sessionId);
  const entry = pendingPromptCompletions.get(sessionId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingPromptCompletions.delete(sessionId);
    entry.resolve();
  }
}

/** Reject a pending prompt completion for a session with an error. */
export function rejectPromptCompletion(sessionId: string, error: Error) {
  activeNudges.delete(sessionId);
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

  // ── Phase 1: time-based guards — UNCONDITIONAL, no HTTP upstream ──
  //
  // These previously ran downstream of `session.status()`. When OpenCode
  // wedged (the very failure these guards exist to catch), that unbounded
  // HTTP call hung or errored and EVERY guard was silently skipped —
  // observed in PROD as beat_1_1781237063151 going 8.5 minutes dark with
  // no stall, no nudge, no reasoning_stall, until run-beat's raw 15-min
  // timer finally fired. The watchdogs must never depend on the health of
  // the process they police.
  for (const [sessionId, entry] of pendingPromptCompletions) {
      // T-minus wrap-up: tell the agent to checkpoint before the hard cap
      // lands. Fires once per beat, beat-sized sessions only.
      if (
        !entry.wrapUpSent &&
        entry.capMs >= WRAP_UP_MIN_CAP_MS &&
        Date.now() - entry.startedAt > entry.capMs - WRAP_UP_LEAD_MS
      ) {
        entry.wrapUpSent = true;
        const wrapCtx = getSessionContext(sessionId);
        if (wrapCtx) {
          emitEmployeeActivity(
            "system",
            "info",
            `Wrap-up nudge: session ${sessionId.slice(0, 12)}… ~${Math.max(0, Math.round((entry.capMs - (Date.now() - entry.startedAt)) / 1000))}s to hard cap — telling agent to checkpoint`,
          );
          swallowAndAudit("beat.wrap_up_nudge", async () => {
            const opencode = await getOpencode();
            const deployment = ensureDeployment("workerDeployment");
            await opencode.client.session.prompt({
              path: { id: sessionId },
              body: {
                model: { providerID: "azure", modelID: deployment },
                agent: wrapCtx.role,
                parts: [{ type: "text", text: WRAP_UP_TEXT }],
              },
              // Same zombie-socket bound as the stall nudge: the beat has
              // ≤2 min + response time left; past 5 min this call can only
              // be outliving its reaped beat.
              signal: AbortSignal.timeout(5 * 60 * 1000),
            });
          }, { detail: { sessionId } });
        }
      }

      // Stall guard: if no SSE event has touched this session in BEAT_STALL_TIMEOUT_MS,
      // the in-flight request is hung. First response: abort + re-prompt the
      // same session (context intact) — see STALL_NUDGE_LIMIT. Only when
      // nudges are exhausted does the beat get reaped.
      if (Date.now() - entry.lastActivityAt > BEAT_STALL_TIMEOUT_MS) {
        // Model is mid-tool-call emission (pending tool part) — the
        // stream is silent by design while arguments generate; do not
        // nudge or reap. See TOOL_ARG_STREAM_GRACE_MS.
        if (isToolArgStreaming(entry)) continue;
        if (entry.nudgeCount < STALL_NUDGE_LIMIT) {
          entry.nudgeCount += 1;
          // Fresh windows for the recovered attempt: the silence guard
          // restarts, and lastToolAt moves so REASONING_STALL doesn't
          // reap the nudged attempt for its predecessor's dead air.
          entry.lastActivityAt = Date.now();
          entry.lastToolAt = Date.now();
          activeNudges.add(sessionId);
          emitEmployeeActivity(
            "system",
            "info",
            `Stall nudge: session ${sessionId.slice(0, 12)}… silent past ${BEAT_STALL_TIMEOUT_MS / 1000}s — aborting hung request and re-prompting (${entry.nudgeCount}/${STALL_NUDGE_LIMIT})`,
          );
          swallowAndAudit("beat.stall_nudge", () => nudgeStalledSession(sessionId), { detail: { sessionId } });
          continue;
        }
        emitEmployeeActivity("system", "info", `Stall detected: session ${sessionId.slice(0, 12)}… silent for ${BEAT_STALL_TIMEOUT_MS / 1000}s after ${entry.nudgeCount} nudge(s) — rejecting`);
        rejectPromptCompletion(sessionId, new Error(`Beat session ${sessionId} stalled: no SSE activity for ${BEAT_STALL_TIMEOUT_MS}ms (nudges exhausted: ${entry.nudgeCount})`));
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

      // Reasoning-stall guard: the beat HAS called tools before, but the
      // last one completed > REASONING_STALL_TIMEOUT_MS ago while the SSE
      // stream stays "alive" with reasoning/text deltas. Without this the
      // only thing that ends such a beat is the hard cap. Cause string is
      // load-bearing: beat-scoring + inspector group on it.
      if (entry.toolCallCount > 0 && Date.now() - entry.lastToolAt > REASONING_STALL_TIMEOUT_MS && !isToolArgStreaming(entry)) {
        emitEmployeeActivity(
          "system",
          "info",
          `Reasoning stall: session ${sessionId.slice(0, 12)}… ${Math.round((Date.now() - entry.lastToolAt) / 1000)}s since last tool call — rejecting`,
        );
        rejectPromptCompletion(
          sessionId,
          new Error(`Beat session ${sessionId} hit reasoning_stall: no tool call for ${REASONING_STALL_TIMEOUT_MS}ms while streaming`),
        );
        continue;
      }

      // Layer B′ productive-action deadline — DISABLED.
      //
      // History: this watchdog rejected beats that had emitted tools
      // but none of them in ACTION_TOOLS_RESETTING_READ_LOOP within
      // NO_PRODUCTIVE_ACTION_DEADLINE_MS. Intended to catch the
      // "task_get + task_append_plan_step → silence" meta-loop.
      //
      // In practice it false-fired on legitimate developer/designer
      // beats: model emits task_append_plan_step (now 2.6s round-trip),
      // then patch_progress, then sits on a long read/edit pass — and
      // gets killed at the 122s mark even though it's actively working.
      // The earlier mitigation (adding built-in tools to
      // BUILTIN_PRODUCTIVE_TOOLS in beats.routes.ts) didn't cover the
      // case where the plugin doesn't POST a body for arceus_* tools,
      // and the read-loop counter (READ_LOOP_THRESHOLD=200) already
      // catches the actual pathology this was meant to catch.
      //
      // The remaining stall guards are sufficient:
      //   • BEAT_STALL_TIMEOUT_MS (150s total SSE silence → stall-nudge)
      //   • NO_TOOL_INVOKED_DEADLINE_MS (45s zero-tool beats)
      //   • REASONING_STALL_TIMEOUT_MS (6 min since last tool call)
      //   • DEFAULT_PROMPT_TIMEOUT_MS / beatTimeoutMs (15 min hard cap)
      //   • READ_LOOP_THRESHOLD=200 (line-by-line read pathology)
      //
      // Keep lastProductiveActionAt populated (it's still useful for
      // observability + the future "live status" view) but do not
      // reject on it. To re-enable, restore the if-block AND ensure
      // every mutating arceus_* / built-in tool resets the counter.
      void NO_PRODUCTIVE_ACTION_DEADLINE_MS;

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

  }

  // ── Phase 2: status-based idle resolution — best-effort, BOUNDED ──
  //
  // Separated from the guards above so a wedged OpenCode can only cost us
  // the idle-resolution convenience (SSE session.idle remains the primary
  // resolution path), never the watchdogs. Both HTTP calls carry abort
  // bounds for the same reason.
  try {
    const opencode = await getOpencode();
    const statusResult = await opencode.client.session.status({
      signal: AbortSignal.timeout(10_000),
    });
    const statusMap = statusResult.data as Record<string, { type: string }> | undefined;
    if (!statusMap) return;

    for (const [sessionId] of pendingPromptCompletions) {
      const sessionStatus = statusMap[sessionId];
      if (sessionStatus?.type === "idle") {
        emitEmployeeActivity("system", "info", `Polling fallback: session ${sessionId.slice(0, 12)}… is idle — resolving completion`);
        resolvePromptCompletion(sessionId);
      } else if (!sessionStatus) {
        try {
          const messagesResult = await opencode.client.session.messages({
            path: { id: sessionId },
            signal: AbortSignal.timeout(10_000),
          });
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
