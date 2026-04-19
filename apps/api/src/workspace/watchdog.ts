import {
  activeExecution,
  executionStatus,
  setExecutionStatus,
  agentSessions,
  DEVELOPER_STALL_TIMEOUT_MINUTES,
  DEVELOPER_STALL_TIMEOUT_MS,
  developerWatchdog,
  setDeveloperWatchdog,
} from "../orchestration/state.js";
import { summarizeDeveloperStall } from "../agents/sessions.js";
import { updateAgentSessionState } from "../agents/sessions.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { setTaskStatus } from "../tasks/mutations.js";
import { recordMeeting } from "../meetings/recording.js";
import { stopDeveloperWorkspaceMonitor } from "./monitor.js";

export function clearDeveloperWatchdog() {
  if (!developerWatchdog) return;
  clearTimeout(developerWatchdog);
  setDeveloperWatchdog(null);
}

export function scheduleDeveloperWatchdog(failDeveloperStallFn: (sessionId: string) => Promise<void>) {
  clearDeveloperWatchdog();

  if (!activeExecution || executionStatus !== "executing") return;

  const developerSession = agentSessions.get("developer");
  if (!developerSession || developerSession.status !== "working") return;

  const timer = setTimeout(() => {
    void failDeveloperStallFn(developerSession.sessionId);
  }, DEVELOPER_STALL_TIMEOUT_MS);
  setDeveloperWatchdog(timer);
}

export async function failDeveloperStall(sessionId: string) {
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

  setExecutionStatus("error");
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
