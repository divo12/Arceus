// heartbeats/event-bridge.ts — SSE event bridge from OpenCode → agent state
import type { AgentIdentity, PolicyEvalContext } from "@arceus/contracts";
import { parseRoleStrict, observability } from "@arceus/contracts";
import { buildTrustEvent, evaluatePolicy, BASE_POLICY_RULES, ROLE_CAPABILITIES } from "@arceus/company-runtime";
import { nowIso } from "@arceus/task-engine";

/**
 * Audit C12 — typed shapes for OpenCode SSE events. Previously this
 * file received `Record<string, any>` and lit up ~45 no-unsafe-* lints
 * for every property access. The shapes below mirror what OpenCode's
 * `/event` stream actually sends; everything is optional because
 * OpenCode evolves its payload and the bridge defends with `??`
 * fallbacks rather than crashing.
 */
interface OpenCodePart {
  type: string;
  // Text-part shapes
  text?: string;
  content?: string;
  delta?: string;
  // Tool-part shapes (older + newer forms coexist in the wire format)
  toolInvocation?: { toolName?: string; args?: Record<string, unknown> };
  tool?: string;
  name?: string;
  state?: { status?: string; input?: Record<string, unknown> };
  sessionID?: string;
}

interface OpenCodeEventProperties {
  sessionID?: string;
  info?: { sessionID?: string };
  part?: OpenCodePart;
  error?: { message?: string; data?: { message?: string } };
  // message.part.delta shape (1.17.x): no part object — just a pointer
  // to the part being streamed plus the incremental text.
  partID?: string;
  field?: string;
  delta?: string;
}

interface OpenCodeEvent {
  type: string;
  properties?: OpenCodeEventProperties;
}
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { getOpencode } from "../infra/opencode.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { auditAgent } from "../observability/audit-ledger.js";
import { swallowAndAudit } from "../observability/swallow.js";
import { sanitizeToolArgs, truncateTelemetry, extractPreviewUrls } from "../infra/utils.js";
import { cpLoadTrustScore, cpUpdateTrustScore, cpRecordPolicyViolation } from "../persistence/control-plane/index.js";
import {
  agentSessions,
  getActiveExecution,
  eventBridgeOnce,
  pendingPromptCompletions,
  getDeveloperStepLoopActive,
  setExecutionStatus,
  setCurrentDeveloperSessionKey,
} from "../orchestration/state.js";
import { updateAgentSessionState, touchAgentSession, resolveRoleBySessionId, roleFromKey } from "../agents/sessions.js";
import { resolvePromptCompletion, rejectPromptCompletion } from "../prompts/llm.js";
import { getSessionContext } from "../orchestration/session-context.js";
import { scheduleDeveloperWatchdog, clearDeveloperWatchdog, failDeveloperStall } from "../workspace/watchdog.js";
import { stopDeveloperWorkspaceMonitor } from "../workspace/monitor.js";
import { registerReportedPreviewUrl } from "../workspace/preview.js";
import { recordMeeting } from "../meetings/recording.js";
import { setTaskStatus, setTaskPreviewUrl, appendTaskResult, appendTaskCommand } from "../tasks/mutations.js";

/**
 * Start the SSE event bridge that streams events from OpenCode into
 * agent state, governance audit, and prompt completion tracking.
 *
 * Audit C6 (F-273/F-274/F-290): the previous `eventBridgeStarted`
 * boolean had a check-then-set race — two callers both observed
 * `false` and started parallel bridges. Now `eventBridgeOnce`
 * (`OncePromise`) dedups concurrent starts: the first caller's
 * promise is shared; the promise auto-clears on settle so a failed
 * start is retryable. Use `eventBridgeOnce.run(() => startEventBridge())`
 * from callers; the flag-style "is it running?" check becomes
 * `eventBridgeOnce.isInFlight`.
 */
export async function startEventBridge(): Promise<void> {
  try {
    const opencode = await getOpencode();
    const response = await fetch(`${opencode.server.url}/event`);

    if (!response.ok || !response.body) {
      emitEmployeeActivity("system", "error", "Failed to connect to OpenCode event stream");
      throw new Error(`OpenCode /event responded ${response.status}`);
    }

    // Type the reader explicitly — fetch's getReader() returns a generic
    // any-typed reader that lights up two no-unsafe-* lints. The wire is
    // bytes; OpenCode emits NDJSON over UTF-8.
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
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

        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLine);
        } catch {
          continue; // malformed event — skip
        }
        // processEvent is async; surface any rejection rather than swallowing
        // (was `void processEvent(...)` — F-289 / C3 sweep extra).
        processEvent(parsed as OpenCodeEvent).catch((err: unknown) => {
          emitEmployeeActivity("system", "error", `event-bridge processEvent failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  } catch (err) {
    emitEmployeeActivity("system", "info", `Event bridge disconnected — will reconnect (${err instanceof Error ? err.message : String(err)})`);
    // OncePromise auto-clears on reject; nothing to flip here.
    // Do NOT call resetOpencodeConnection() here. SSE disconnects are usually
    // transient (network blip, slow consumer). Killing the OpenCode child on
    // every drop caused dual-boot: kill → port not yet released → respawn
    // falls back to a random port. scheduleReconnect re-establishes the SSE
    // against the SAME running OpenCode; if the server is genuinely dead the
    // reconnect will fail and surface via the OncePromise reject path.
    scheduleReconnect();
    // Re-throw so a caller doing `await startEventBridge()` knows the
    // handshake never came up. Callers that don't care can `.catch(() => {})`.
    throw err;
  }
}

// Cluster C17 — F-302. Exponential backoff with jitter so persistent
// OpenCode downtime doesn't reconnect-storm the upstream. Resets to base
// once a successful connection lasts longer than `successResetMs`.
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 16_000;
const RECONNECT_JITTER_MS = 250;
let reconnectAttempt = 0;
let lastReconnectAt = 0;

function scheduleReconnect(): void {
  // If the previous connection lasted long enough, treat the next failure
  // as fresh (reset attempt counter).
  if (Date.now() - lastReconnectAt > RECONNECT_MAX_MS * 4) {
    reconnectAttempt = 0;
  }
  const exp = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  const jitter = Math.random() * RECONNECT_JITTER_MS;
  const delayMs = exp + jitter;
  reconnectAttempt += 1;
  lastReconnectAt = Date.now();

  setTimeout(() => {
    // OncePromise dedups concurrent starts — if a parallel caller
    // already kicked off a reconnect we share their promise. Errors
    // routed through swallowAndAudit; the bridge's own catch resets
    // the OncePromise so the next reconnect can re-enter cleanly.
    swallowAndAudit("event_bridge.reconnect", () =>
      eventBridgeOnce.run(() => startEventBridge()),
    );
  }, delayMs);
}

// agent.reasoning throttle — at most one inspector event per session per
// interval. Cleared wholesale at 500 entries (sessions are short-lived).
const REASONING_EMIT_INTERVAL_MS = 3_000;
const lastReasoningEmitAt = new Map<string, number>();

// partID → part type, learned from message.part.updated events. Needed
// because message.part.delta events (1.17.x) carry NO part object — just
// {partID, field, delta} — so without this map the live reasoning deltas
// are unclassifiable and the inspector would only show reasoning at part
// completion instead of while the model thinks. Cleared wholesale at
// 2000 entries (parts are tiny, short-lived ids).
const partTypeById = new Map<string, string>();

/** Dispatch a single SSE event to the appropriate agent state / governance handler. */
async function processEvent(event: OpenCodeEvent) {
  const props = event.properties;
  if (!props) return;

  const sessionId: string | undefined = props.info?.sessionID ?? props.part?.sessionID ?? props.sessionID;
  // P3 — Diagnostic instrumentation for the stall investigation. Logs:
  //   - event.type
  //   - whether sessionId was extracted (proves SSE events have it)
  //   - whether it matched an in-flight beat (proves the reset CAN fire)
  // Stalls in beats 9/12/17/13 fired at exactly beat-start + timeout
  // despite tool calls happening — this log lets us see at runtime which
  // events actually reach the bridge during the silence window. Volume:
  // a few events/sec per active session — bounded.
  const pendingCompletion = sessionId ? pendingPromptCompletions.get(sessionId) : undefined;
  if (process.env.ARCEUS_SSE_DEBUG === "1" || !sessionId || pendingCompletion) {
    const sessTag = sessionId ? sessionId.slice(0, 12) : "<none>";
    const pendTag = sessionId ? (pendingCompletion ? "hit" : "miss") : "n/a";
    console.log(`[sse] type=${event.type} session=${sessTag} pending=${pendTag}`);
  }
  if (!sessionId) return;

  // Reset the stall clock for any session that has a pending completion — this
  // includes beat sessions which aren't in agentSessions and would otherwise
  // fall through the `!role` guard below before we could touch them.
  if (pendingCompletion) {
    pendingCompletion.lastActivityAt = Date.now();
  }

  // agent.reasoning emission — moved here from the OpenCode plugin's
  // message.part.updated hook, which silently broke on the 1.17.x payload
  // shape change (reasoning streams via separate message.part.delta
  // events; sessionID nested under part). The bridge already parses these
  // events for the stall clock, so emitting here makes "what feeds the
  // watchdog" and "what the inspector shows" the same stream by
  // construction — they can never disagree again. Throttled per session:
  // reasoning deltas are high-frequency and this is visibility, not
  // telemetry-of-record.
  if (event.type === "message.part.updated" || event.type === "message.part.delta") {
    // Learn part types from `updated` events (which carry the full part)
    // so the part-less `delta` events can be classified by partID.
    const part = props.part;
    if (part?.type && (part as { id?: string }).id) {
      if (partTypeById.size > 2_000) partTypeById.clear();
      partTypeById.set((part as { id?: string }).id!, part.type);
    }

    const isReasoning =
      part?.type === "reasoning" ||
      (event.type === "message.part.delta" &&
        props.partID !== undefined &&
        partTypeById.get(props.partID) === "reasoning");

    if (isReasoning) {
      const lastEmit = lastReasoningEmitAt.get(sessionId) ?? 0;
      const nowMs = Date.now();
      if (nowMs - lastEmit >= REASONING_EMIT_INTERVAL_MS) {
        if (lastReasoningEmitAt.size > 500) lastReasoningEmitAt.clear();
        lastReasoningEmitAt.set(sessionId, nowMs);
        const reasoningCtx = getSessionContext(sessionId);
        const text = part?.text ?? part?.delta ?? part?.content ?? props.delta ?? "";
        if (reasoningCtx && text) {
          observability.logEvent({
            event: "agent.reasoning",
            beatId: reasoningCtx.beatId,
            role: reasoningCtx.role,
            text: truncateTelemetry(text, 4_000),
            ts: nowMs,
          } as unknown as Parameters<typeof observability.logEvent>[0]);
        }
      }
    }
  }

  // resolveRoleBySessionId now returns the compound `companyId:role` key.
  const sessionKey = resolveRoleBySessionId(sessionId);
  if (!sessionKey) return;
  const role = roleFromKey(sessionKey);

  // Capture once per event so TS narrowing on `if (activeExecution)` works
  // and we don't read inconsistent runtime state mid-handler.
  const activeExecution = getActiveExecution();
  const developerStepLoopActive = getDeveloperStepLoopActive();

  // Capability flags replace `role === "developer"` checks across this bridge.
  // Add new behaviours by extending ROLE_CAPABILITIES, never by adding role string
  // comparisons here. See plans/code-audit/anti-patterns.md #9.
  const caps = (ROLE_CAPABILITIES as Record<string, { ownsProductWorkspace: boolean; escalatesOnSessionError: boolean }>)[role]
    ?? { ownsProductWorkspace: false, escalatesOnSessionError: false };

  const agentState = agentSessions.get(sessionKey);
  if (agentState) {
    updateAgentSessionState(sessionKey, {
      lastEventAt: nowIso(),
      lastEventType: event.type,
      eventCount: agentState.eventCount + 1,
      stallReason: null,
    });
    touchAgentSession(sessionKey);
    if (caps.ownsProductWorkspace) {
      // Track the active developer session key so watchdog/monitor can resolve it.
      setCurrentDeveloperSessionKey(sessionKey.split(":")[0], sessionKey);
      if (agentState.status === "working") {
        scheduleDeveloperWatchdog(failDeveloperStall);
      }
    }
  }

  if (event.type === "message.part.updated" && props.part) {
    const part = props.part;

    if (part.type === "text") {
      const textContent = String(part.text ?? part.content ?? part.delta ?? "");
      if (textContent) {
        updateAgentSessionState(sessionKey, {
          lastProgressAt: nowIso(),
          lastEventSummary: truncateTelemetry(textContent),
          awaiting: "streaming response",
        });
      }
      if (caps.ownsProductWorkspace && textContent) {
        for (const previewUrl of extractPreviewUrls(textContent)) {
          // Route preview URL to the active execution's company slot so
          // two tenants reporting URLs in parallel don't overwrite each
          // other's state. Falls back to the singleton when no active
          // execution is set (legacy non-multi-tenant boot path).
          const registered = await registerReportedPreviewUrl(previewUrl, activeExecution?.companyId);
          if (registered && activeExecution) {
            void setTaskPreviewUrl(activeExecution.buildTaskId, previewUrl);
            void appendTaskResult(activeExecution.buildTaskId, `preview:${previewUrl}`);
            emitEmployeeActivity(role, "info", `${role} reported preview URL → ${previewUrl}`, {
              taskId: activeExecution.buildTaskId,
            });
          }
        }
      }
    }

    if (part.type === "tool-invocation" || part.type === "tool-result" || part.type === "tool") {
      const toolName: string = part.toolInvocation?.toolName ?? part.tool ?? part.name ?? "";
      const args: Record<string, unknown> = part.toolInvocation?.args ?? part.state?.input ?? {};
      const toolStatus: string = part.state?.status ?? "";
      const isInvocation = part.type === "tool-invocation";

      if (toolName) {
        updateAgentSessionState(sessionKey, {
          lastToolName: toolName,
          lastToolStatus: isInvocation ? "invoked" : "completed",
          lastToolAt: nowIso(),
          lastProgressAt: nowIso(),
          lastEventSummary: `${isInvocation ? "Running" : "Completed"} tool ${toolName}`,
          awaiting: isInvocation ? `waiting for ${toolName} result` : "processing tool result",
          toolInvocationCount: isInvocation ? (agentSessions.get(sessionKey)?.toolInvocationCount ?? 0) + 1 : agentSessions.get(sessionKey)?.toolInvocationCount ?? 0,
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
          // Spec 31 Phase 7.B.3 — agent lookup goes through canonical;
          // companyId is already in scope from `activeExecution`.
          const agent = await agentsRepo.findAgentByRole(getDb(), companyId, role);
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
              // C3 — F-291 fix: await both governance writes. The violation
              // and trust adjustment are causally linked (a denied tool
              // call must produce both a violation row and a score drop)
              // and should land atomically from the bridge's perspective.
              // Failures propagate to processEvent's outer .catch in the
              // SSE loop where they get logged as bridge errors.
              await cpRecordPolicyViolation({
                id: violationId, companyId, agentId: agent.id, ruleId: decision.ruleId,
                tool: toolName, decision: decision.decision, severity: "high",
                detail: `Agent ${role} invoked denied tool ${toolName}: ${decision.reason}`,
                beatId: null,
                resolvedAt: null, createdAt: new Date().toISOString(),
              });
              const trustEvent = buildTrustEvent(agent.id, "violation", `Invoked denied tool ${toolName}`, new Date().toISOString());
              await cpUpdateTrustScore(trustEvent);
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

      // Resolve the active task ID for this role — capability-gated, not role-gated.
      const resolvedTaskId = (caps.ownsProductWorkspace && activeExecution?.buildTaskId)
        ? activeExecution.buildTaskId
        : agentSessions.get(sessionKey)?.activeTaskId ?? null;

      if (isInvocation && (toolName === "edit" || toolName === "write" || toolName === "patch" || toolName === "apply_patch")) {
        // args is `Record<string, unknown>` — coerce to string with explicit fallbacks.
        const asString = (v: unknown): string => typeof v === "string" ? v : "";
        const filePath = asString(args.filePath) || asString(args.file_path) || "unknown file";
        const newContent = asString(args.newString) || asString(args.new_str) || asString(args.content) || asString(args.patch);
        const linesChanged = newContent.length > 0 ? newContent.split("\n").length : undefined;
        updateAgentSessionState(sessionKey, {
          fileEditCount: (agentSessions.get(sessionKey)?.fileEditCount ?? 0) + 1,
          lastEventSummary: `Edited ${filePath}`,
          lastWorkspaceChangeAt: nowIso(),
          awaiting: "continuing after file edit",
        });
        emitEmployeeActivity(role, "file_edit", filePath, {
          taskId: resolvedTaskId,
          detail: linesChanged ? { linesChanged } : null,
        });
        if (resolvedTaskId) {
          void appendTaskResult(resolvedTaskId, `edited:${filePath}`);
        }
      } else if (isInvocation && toolName === "bash") {
        const cmd = (typeof args.command === "string" ? args.command : "").slice(0, 180);
        updateAgentSessionState(sessionKey, {
          shellCommandCount: (agentSessions.get(sessionKey)?.shellCommandCount ?? 0) + 1,
          lastEventSummary: `$ ${cmd}`,
          awaiting: "waiting for shell result",
        });
        emitEmployeeActivity(role, "shell", `$ ${cmd}`, {
          taskId: resolvedTaskId,
        });
        if (resolvedTaskId) {
          void appendTaskCommand(resolvedTaskId, cmd);
        }
      } else if (isInvocation && toolName) {
        emitEmployeeActivity(role, "tool_call", `tool: ${toolName}`, {
          taskId: resolvedTaskId,
          detail: { toolName, args: sanitizeToolArgs(args) },
        });
        if (resolvedTaskId) {
          void appendTaskResult(resolvedTaskId, `tool:${toolName}`);
        }
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
    // The loop itself handles progression — don't trigger post-completion routing here.
    if (caps.ownsProductWorkspace && developerStepLoopActive) {
      touchAgentSession(sessionKey, "working");
      updateAgentSessionState(sessionKey, {
        lastProgressAt: nowIso(),
        lastEventSummary: "Step prompt completed. Verifying…",
      });
      return;
    }

    touchAgentSession(sessionKey, "done");
    updateAgentSessionState(sessionKey, {
      awaiting: "idle",
      promptCompletedAt: nowIso(),
      lastProgressAt: nowIso(),
      activeTaskId: caps.ownsProductWorkspace ? activeExecution?.previewTaskId ?? null : null,
      lastEventSummary: caps.ownsProductWorkspace
        ? "Implementation finished. Handing off to preview validation."
        : "Work complete.",
    });
    if (caps.ownsProductWorkspace) {
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

    touchAgentSession(sessionKey, "error");
    updateAgentSessionState(sessionKey, {
      awaiting: "session error",
      promptCompletedAt: nowIso(),
      stallReason: props.error?.message ?? "Session error",
      lastEventSummary: props.error?.message ?? "Session error",
    });
    const isInternalAgent = role.startsWith("_internal/");
    if (caps.ownsProductWorkspace) {
      clearDeveloperWatchdog();
      stopDeveloperWorkspaceMonitor();
    }
    // Internal agent errors (memory, facilitator, etc.) should not poison global execution state
    if (!isInternalAgent) {
      setExecutionStatus("error");
    }
    if (caps.escalatesOnSessionError && activeExecution) {
      await setTaskStatus(activeExecution.buildTaskId, "failed", props.error?.message ?? `${role} session error`);
      const typedRole = parseRoleStrict(role);
      await recordMeeting({
        type: "escalation",
        facilitatorRole: typedRole,
        participantRoles: [typedRole, "cto", "ceo"],
        summary: `${role} session failed and was escalated to leadership.`,
        agenda: [
          {
            topic: `${role} runtime failure`,
            type: "blocker",
            content: props.error?.message ?? `${role} session error`,
            raisedByRole: typedRole,
            relatedTaskId: activeExecution.buildTaskId,
          },
        ],
        decisions: [
          {
            description: `Leadership will review the ${role} runtime failure before resuming execution.`,
            decidedByRoles: [typedRole, "cto", "ceo"],
            impactIds: [activeExecution.buildTaskId],
          },
        ],
      });
    }
    if (!isInternalAgent) {
      emitEmployeeActivity(role, "error", props.error?.message ?? "Session error", {
        taskId: caps.ownsProductWorkspace ? activeExecution?.buildTaskId ?? null : null,
      });
    }
  }
}
