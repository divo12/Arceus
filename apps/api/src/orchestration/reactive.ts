import type { AgentIdentity, BeatEventTrigger } from "@arceus/contracts";
import { parseRoleStrict } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { buildSnapshotView } from "./snapshot-view.js";
import { getMeetingSchedulerRef, getReactiveEventEmitter } from "./state.js";
import { swallowAndAudit } from "../observability/swallow.js";

/**
 * Emit a reactive event for a specific role. Spec 31 Phase 7.B.3 —
 * agent lookup goes through `agentsRepo.findAgentByRole` (canonical).
 * Reactive events are best-effort and fire-and-forget so the
 * surface stays sync — the 15+ callers don't have to async-cascade.
 *
 * Multi-tenancy: `companyId` is the tenant the event belongs to. It
 * MUST come from the caller's scope (task.companyId, sprint.companyId,
 * snapshot.company.id, etc.) — NOT from a process-wide singleton.
 * Calling with the wrong companyId wakes an agent in the wrong tenant
 * and silently drops the originating tenant's reactive signal.
 */
export function emitReactive(companyId: string, role: AgentIdentity["role"], event: BeatEventTrigger): void {
  const emitter = getReactiveEventEmitter();
  if (!emitter || !companyId) return;
  swallowAndAudit("reactive.emit_reactive", async () => {
    const agent = await agentsRepo.findAgentByRole(getDb(), companyId, role);
    if (!agent) return;
    emitter(companyId, agent.id, role, event);
  },
    { companyId, agentRole: role, detail: { event } },
  );
}

/**
 * Emit a reactive event to ALL agents of a tenant. Spec 31 Phase 7.B.3
 * — `agentsRepo.listAgentsByCompany` replaces `snapshot.agents`.
 * Fire-and-forget like `emitReactive`. `companyId` MUST be the tenant
 * the broadcast targets; without it the broadcast goes nowhere.
 */
export function emitReactiveBroadcast(companyId: string, event: BeatEventTrigger): void {
  const emitter = getReactiveEventEmitter();
  if (!emitter || !companyId) return;
  swallowAndAudit("reactive.broadcast", async () => {
    const agents = await agentsRepo.listAgentsByCompany(getDb(), companyId);
    for (const agent of agents) {
      emitter(companyId, agent.id, parseRoleStrict(agent.role), event);
    }
  },
    { companyId, detail: { event } },
  );
}

/**
 * Whether the auto-escalation pipeline is allowed to fire when a task
 * transitions to `blocked`. OFF by default — at concurrency > 1 we
 * observe gpt-5.4-mini hallucinating block reasons (e.g. "validation
 * failed" when no error envelope ever fired), and firing a sync
 * meeting on every block creates idle time + ties up the manager
 * agent on bogus escalations. Recovery happens via the agent's next
 * beat re-claiming the blocked task instead.
 *
 * Set `ARCEUS_ESCALATION_MEETINGS_ENABLED=1` in production to restore
 * the original behavior once block-reason hallucinations are
 * controlled (prompt rule "truth in tool errors" + observation that
 * the rate has dropped).
 */
function escalationMeetingsEnabled(): boolean {
  return process.env.ARCEUS_ESCALATION_MEETINGS_ENABLED === "1";
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
 *
 * Gated by `ARCEUS_ESCALATION_MEETINGS_ENABLED`. When disabled, we
 * audit the suppression so operators can see in `activity_log` that
 * a block fired without escalating, and rely on the agent's own
 * next beat to re-claim and retry.
 */
export function triggerEscalationMeeting(companyId: string, taskId: string, blockerDetail: string): void {
  if (!companyId) return;

  if (!escalationMeetingsEnabled()) {
    // Best-effort audit so the inspector + ops can observe the
    // suppression. Not an error — this is the configured policy.
    swallowAndAudit("reactive.escalation_meeting_suppressed", async () => {
      // No-op DB work; the audit row is the whole point of this path.
    }, {
      companyId,
      detail: {
        taskId,
        blockerDetail: blockerDetail.slice(0, 200),
        reason: "ARCEUS_ESCALATION_MEETINGS_ENABLED is not set; agent should re-claim blocked task on next beat",
      },
    });
    return;
  }

  const scheduler = getMeetingSchedulerRef();
  if (!scheduler) return;

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
