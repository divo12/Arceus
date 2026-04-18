import type { AgentIdentity, BeatEventTrigger } from "@arceus/contracts";
import { getAgentByRole } from "@arceus/task-engine";
import { getSnapshot } from "../persistence/store.js";
import { getMeetingSchedulerRef, getReactiveEventEmitter } from "./state.js";

/** Emit a reactive event for a specific role (resolves agentId from snapshot). */
export function emitReactive(role: AgentIdentity["role"], event: BeatEventTrigger) {
  const emitter = getReactiveEventEmitter();
  if (!emitter) return;
  const snapshot = getSnapshot();
  const agent = getAgentByRole(snapshot, role);
  if (!agent) return;
  emitter(snapshot.company.id, agent.id, role, event);
}

/** Emit a reactive event to ALL agents (used for broadcast events like sprint_started). */
export function emitReactiveBroadcast(event: BeatEventTrigger) {
  const emitter = getReactiveEventEmitter();
  if (!emitter) return;
  const snapshot = getSnapshot();
  for (const agent of snapshot.agents) {
    emitter(snapshot.company.id, agent.id, agent.role, event);
  }
}

/**
 * Trigger an escalation meeting for a blocked task.
 * Called from setTaskStatus() when a task transitions to "blocked".
 */
export function triggerEscalationMeeting(taskId: string, blockerDetail: string) {
  const scheduler = getMeetingSchedulerRef();
  if (!scheduler) return;
  const snap = getSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task || !task.assignedRole) return;

  const agent = snap.agents.find((a) => a.role === task.assignedRole);
  if (!agent) return;

  scheduler.createEscalationMeeting(snap, agent.id, blockerDetail, taskId);
}
