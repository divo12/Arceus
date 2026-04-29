import type { AgentIdentity, BeatEventTrigger } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "./snapshot-view.js";
import { getMeetingSchedulerRef, getReactiveEventEmitter } from "./state.js";
import { swallowAndAudit } from "../observability/swallow.js";

/**
 * Emit a reactive event for a specific role. Spec 31 Phase 7.B.3 —
 * agent lookup goes through `agentsRepo.findAgentByRole` (canonical).
 * Reactive events are best-effort and fire-and-forget so the
 * surface stays sync — the 15+ callers don't have to async-cascade.
 *
 * `companyId` still derives from the in-memory snapshot until B.5
 * threads it through via `companyContext`.
 */
export function emitReactive(role: AgentIdentity["role"], event: BeatEventTrigger): void {
  const emitter = getReactiveEventEmitter();
  if (!emitter) return;
  const companyId = getActiveCompanyId();
  if (!companyId) return;
  swallowAndAudit("reactive.emit_reactive", async () => {
    const agent = await agentsRepo.findAgentByRole(getDb(), companyId, role);
    if (!agent) return;
    emitter(companyId, agent.id, role, event);
  },
    { companyId, agentRole: role, detail: { event } },
  );
}

/**
 * Emit a reactive event to ALL agents. Spec 31 Phase 7.B.3 —
 * `agentsRepo.listAgentsByCompany` replaces `snapshot.agents`.
 * Fire-and-forget like `emitReactive`.
 */
export function emitReactiveBroadcast(event: BeatEventTrigger): void {
  const emitter = getReactiveEventEmitter();
  if (!emitter) return;
  const companyId = getActiveCompanyId();
  if (!companyId) return;
  swallowAndAudit("reactive.broadcast", async () => {
    const agents = await agentsRepo.listAgentsByCompany(getDb(), companyId);
    for (const agent of agents) {
      emitter(companyId, agent.id, agent.role as AgentIdentity["role"], event);
    }
  },
    { companyId, detail: { event } },
  );
}

/**
 * Trigger an escalation meeting for a blocked task. Called from
 * `setTaskStatus()` when a task transitions to "blocked".
 *
 * Spec 31 Phase 7.B.4 — fire-and-forget. Resolves the task via
 * `tasksRepo`, the agent via `agentsRepo`, and assembles the
 * meeting-scheduler input via `buildSnapshotView` (the scheduler's
 * `createEscalationMeeting` API still takes a full snapshot —
 * reshaping it is a separate B.4 follow-up). The 5+ callers stay
 * sync because the meeting is best-effort.
 */
export function triggerEscalationMeeting(taskId: string, blockerDetail: string): void {
  const scheduler = getMeetingSchedulerRef();
  if (!scheduler) return;
  const companyId = getActiveCompanyId();
  if (!companyId) return;

  swallowAndAudit("reactive.escalation_meeting", async () => {
    const task = await tasksRepo.findByIdHydrated(getDb(), taskId);
    if (!task?.assignedRole) return;

    const agent = await agentsRepo.findAgentByRole(getDb(), companyId, task.assignedRole);
    if (!agent) return;

    const snapshot = await buildSnapshotView(companyId);
    await scheduler.createEscalationMeeting(snapshot, agent.id, blockerDetail, taskId);
  },
    { companyId, detail: { taskId, blockerDetail: blockerDetail.slice(0, 200) } },
  );
}
