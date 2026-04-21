// heartbeats/event-bridge.ts — SSE event bridge from OpenCode → agent state
import type { AgentIdentity, PolicyEvalContext } from "@arceus/contracts";
import { buildTrustEvent, evaluatePolicy, BASE_POLICY_RULES } from "@arceus/company-runtime";
import { getAgentByRole, nowIso } from "@arceus/task-engine";
import { getOpencode, resetOpencodeConnection } from "../infra/opencode.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { auditAgent } from "../observability/audit-ledger.js";
import { sanitizeToolArgs, truncateTelemetry, extractPreviewUrls } from "../infra/utils.js";
import { getSnapshot } from "../persistence/store.js";
import { cpLoadTrustScore, cpUpdateTrustScore, cpRecordPolicyViolation } from "../persistence/control-plane.js";
import {
  agentSessions,
  activeExecution,
  eventBridgeStarted,
  setEventBridgeStarted,
  pendingPromptCompletions,
  developerStepLoopActive,
  executionStatus,
  setExecutionStatus,
} from "../orchestration/state.js";
import { updateAgentSessionState, touchAgentSession, resolveRoleBySessionId } from "../agents/sessions.js";
import { resolvePromptCompletion, rejectPromptCompletion } from "../prompts/llm.js";
import { scheduleDeveloperWatchdog, clearDeveloperWatchdog, failDeveloperStall } from "../workspace/watchdog.js";
import { stopDeveloperWorkspaceMonitor } from "../workspace/monitor.js";
import { registerReportedPreviewUrl } from "../workspace/preview.js";
import { recordMeeting } from "../meetings/recording.js";
import { setTaskStatus, setTaskPreviewUrl, appendTaskResult, appendTaskCommand } from "../tasks/mutations.js";

/**
 * Start the SSE event bridge that streams events from OpenCode
 * into agent state, governance audit, and prompt completion tracking.
 * Auto-reconnects on disconnect after a brief delay.
 */
export async function startEventBridge() {
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
    setEventBridgeStarted(false);
    resetOpencodeConnection();
    // Auto-reconnect after a brief delay
    setTimeout(() => {
      if (!eventBridgeStarted) {
        startEventBridge().catch(() => {});
        setEventBridgeStarted(true);
      }
    }, 3000);
  }
}

/** Dispatch a single SSE event to the appropriate agent state / governance handler. */
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
      scheduleDeveloperWatchdog(failDeveloperStall);
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
        emitEmployeeActivity(role, "tool_call", `tool: ${toolName}`, {
          taskId: activeExecution?.buildTaskId ?? null,
          detail: { toolName, args: sanitizeToolArgs(args) },
        });
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
    setExecutionStatus("error");
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
