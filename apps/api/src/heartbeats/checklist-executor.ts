// heartbeats/checklist-executor.ts — Execute a checklist-driven action when no task exists
import type { AgentBeatContext, AgentIdentity, ChecklistDispatch } from "@arceus/contracts";
import { loadSkillsLeadPolicy } from "./skills-lead-policy.js";

// Cluster C17 — F-281 + F-288. Read once at module load; env-driven so
// deployments tune via `ARCEUS_SKILLS_LEAD_*` without code changes.
const skillsLeadPolicy = loadSkillsLeadPolicy();
import {
  getRoleSoul, getAgentSkills,
  processTaskOutcome, runATAPipeline,
  getUnderperformingSkills, getUnusedSkills, analyzeSprintPatterns,
  proposeSkillFromCluster, deprecateSkill as registryDeprecateSkill,
  ROLE_CAPABILITIES,
} from "@arceus/company-runtime";
import { getAgentByRole } from "@arceus/task-engine";
import { emitEmployeeActivity, shortBeat } from "../observability/activity.js";
import { auditAgent } from "../observability/audit-ledger.js";
import { swallowAndAudit } from "../observability/swallow.js";
import {
  emitGraphBeatStarted, emitGraphBeatCompleted, resolveActiveSprintId,
} from "../observability/graph-emitter/index.js";
import { startBeatTokenAccumulator, drainBeatTokenAccumulator } from "../infra/azure-openai.js";
import { updateMeeting, updateSprint } from "../persistence/mutations/index.js";
import { requireActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { flush } from "../persistence/mutations/index.js";
import { ensureAgentSession } from "../prompts/llm.js";
import { runPromptText } from "../prompts/llm.js";
import { touchAgentSession } from "../agents/sessions.js";
import { agentSessionKey } from "../orchestration/state.js";
import { applyGovernanceToMutation } from "../skills/governance.js";
import { eventBridgeOnce } from "../orchestration/state.js";
import { registerSessionContext, unregisterSessionContext } from "../orchestration/session-context.js";
import { getAllowedArceusTools } from "../../../../.opencode/agent/config.js";
import { createWorkflowTask } from "@arceus/task-engine";
import { upsertTask } from "../persistence/mutations/index.js";
import { finalizeSprintCompletion } from "../sprints/lifecycle.js";
import {
  executeSprintReviewVerification, executeSprintFinalGate,
  executeRetestAfterRework, executeCtoBeatEscalationReview,
} from "../sprints/review.js";
import { startEventBridge } from "./event-bridge.js";

interface HandlerResult { summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }
type FinishFn = (status: "completed" | "failed", summary: string, toolCalls: number) => void;

/**
 * Audit C11 (F-249/F-251/F-275/F-276/F-286): action contract is now typed.
 * `dispatch` is the machine-routed kind (discriminated union from
 * `@arceus/contracts`). `suggestedAction` is reserved for human display;
 * we no longer parse it via `startsWith` / `split(":")`.
 */
interface ChecklistAction {
  detail: string;
  suggestedAction: string;
  dispatch?: ChecklistDispatch;
}

type ChecklistHandler = (
  ctx: AgentBeatContext,
  action: ChecklistAction,
  beatId: string,
  finish: FinishFn,
) => Promise<HandlerResult>;

/**
 * Kind-keyed dispatch. Record forces every dispatch kind to have a handler
 * at compile time — adding a kind to the union without a handler here is
 * a TS error. Replaces the old prefix-matcher table that parsed
 * colon-strings via `startsWith`.
 */
const DISPATCH_HANDLERS: Record<ChecklistDispatch["kind"], ChecklistHandler> = {
  "sprint_review.cto_escalation_review": handleCtoEscalationReview,
  "sprint_review.cto_escalation_force_complete": handleCtoEscalationForceComplete,
  "sprint_review.run_tester_verification": handleRunTesterVerification,
  "sprint_review.run_final_gate": handleRunFinalGate,
  "sprint_review.retest_after_rework": handleRetestAfterRework,
  "skills_lead.mutate_underperformer": handleSkillsLeadMutateUnderperformer,
  "skills_lead.deprecate_unused": handleSkillsLeadDeprecateUnused,
  "skills_lead.fill_skill_gap": handleSkillsLeadFillSkillGap,
  "meeting_contribution": handleMeetingContribution,
  "task_resolve_blocker": handleTaskResolveBlocker,
};

/**
 * Execute a checklist-driven action when no task is assigned.
 * Dispatches by typed `dispatch.kind` (machine-routed) or falls back to
 * regex / LLM for freeform English actions. The orchestrator stays
 * role-neutral: it routes by what the checklist asked for, not by who
 * the agent is. See plans/agent-redesign/00-vision.md blocker #3.
 */
export async function executeChecklistAction(
  ctx: AgentBeatContext,
  action: ChecklistAction,
  beatId: string,
): Promise<HandlerResult> {
  const role = ctx.role;

  // ── Graph instrumentation (Spec 22) — beat wrapping checklist action ──
  const clBeatId = `cl_${beatId}`;
  const clSprintId = ctx.currentSprint?.id ?? resolveActiveSprintId() ?? "";
  const clBeatStart = Date.now();
  if (clSprintId) {
    emitGraphBeatStarted(clSprintId, clSprintId, clBeatId, role, `checklist:${action.suggestedAction}`, action.detail?.slice(0, 200));
  }
  const finish: FinishFn = (status, summary, toolCalls) => {
    if (clSprintId) emitGraphBeatCompleted(clSprintId, clSprintId, clBeatId, status, summary, toolCalls, Date.now() - clBeatStart);
  };

  // Ensure the SSE event bridge is running. `eventBridgeOnce` dedups
  // concurrent starts (C6 — F-273/274/290 fix); fire-and-forget here
  // because the bridge promise resolves only on disconnect.
  swallowAndAudit("event_bridge.start", () =>
    eventBridgeOnce.run(() => startEventBridge()),
  );

  emitEmployeeActivity(role, "decision", `${shortBeat(beatId)}: ${action.suggestedAction}`, {
    beatId, detail: { suggestedAction: action.suggestedAction, actionDetail: action.detail },
  });

  // ── Typed dispatch (Audit C11 fix) ──
  if (action.dispatch) {
    const handler = DISPATCH_HANDLERS[action.dispatch.kind];
    return handler(ctx, action, beatId, finish);
  }

  // ── Strategic roles reason about freeform actions via LLM ──
  // Per plans/agent-redesign/00-vision.md: the orchestrator does NOT spawn
  // tasks. It wakes the agent with context and lets the agent decide via
  // tools. The CEO uses sprint_check_completion / sprint_finalize / sprint_create.
  if (ROLE_CAPABILITIES[role].respondsToFreeformChecklistActions) {
    return handleFreeformLlmAction(ctx, action, beatId, finish);
  }

  // ── No handler matched ──
  emitEmployeeActivity(role, "info", `${shortBeat(beatId)}: unhandled action "${action.suggestedAction}"`, { beatId });
  finish("completed", `No handler: ${action.suggestedAction}`, 0);
  return {
    summary: `${role}: ${action.suggestedAction} (no handler)`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
  };
}

// ── Action handlers ───────────────────────────────────────────────────────

/**
 * Resolve a blocked/failed task by spawning a single, role-targeted
 * "Fix blocker" follow-up. Idempotent: re-running for the same blocker
 * is a no-op because checkSprintHealth suppresses suggestions once the
 * follow-up exists. This replaces the old generic "Investigate
 * blocked/failed tasks" suggestion that produced infinite no-handler
 * beats and prose-only PM replies.
 */
async function handleTaskResolveBlocker(
  ctx: AgentBeatContext,
  action: ChecklistAction,
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  const role = ctx.role;
  // Audit C11: taskId now comes from typed dispatch (was: split(":") on suggestedAction)
  const taskId = action.dispatch?.kind === "task_resolve_blocker" ? action.dispatch.taskId : "";
  const blocked = ctx.tasks.find((t) => t.id === taskId);
  if (!blocked) {
    finish("completed", `Blocker task ${taskId} no longer present`, 0);
    return {
      summary: `Blocker ${taskId} not found in current snapshot — likely resolved`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }
  // Defensive dedupe: if a "Fix blocker for <id>" task already exists in
  // a non-terminal state, do nothing. checkSprintHealth already filters
  // these out, but a concurrent beat could race.
  const followupTitle = `Fix blocker for ${blocked.id}`;
  const isOpen = (s: string) => !["completed", "cancelled", "failed"].includes(s);
  const existing = ctx.tasks.find((t) => t.title === followupTitle && isOpen(t.status));
  if (existing) {
    finish("completed", `Fix-blocker task already exists (${existing.id})`, 0);
    return {
      summary: `Fix-blocker follow-up ${existing.id} already open for ${blocked.id}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }

  const companyId = requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);
  const blockerReason = blocked.verifierState?.feedback?.slice(0, 400)
    ?? blocked.executorState?.results?.slice(-1)[0]?.slice(0, 400)
    ?? "(no reason recorded)";
  const followup = createWorkflowTask(
    snapshot,
    "implementation",
    blocked.assignedRole, // owner of the original task fixes their own blocker
    followupTitle,
    `Original task "${blocked.title}" (${blocked.id}) is ${blocked.status}. Reason: ${blockerReason}. Diagnose, fix, and either reopen the original task or mark this follow-up complete with a write-up of the resolution.`,
    `Original task ${blocked.id} is ${blocked.status} and the team needs it unblocked.`,
    `Either (a) the original task is back in a runnable state (status planned/in_progress), OR (b) a clear written rationale explaining why the original task is permanently abandoned.`,
    [
      `Diagnose root cause of ${blocked.id} being ${blocked.status}`,
      `Take corrective action (fix code, reassign, split, or formally abandon)`,
      `Update original task status or add explanatory note via task_append_result`,
    ],
    blocked.priority,
    "planned",
    blocked.sprintId ?? null,
  );
  await upsertTask(followup);

  emitEmployeeActivity(role, "transition", `${shortBeat(beatId)}: spawned "${followup.title}" (${followup.id}) for blocker ${blocked.id}`, {
    beatId, taskId: followup.id, detail: { blockerTaskId: blocked.id, blockerStatus: blocked.status },
  });
  finish("completed", `Spawned fix-blocker task for ${blocked.id}`, 0);
  return {
    summary: `Spawned ${followup.id} ("${followup.title}") to resolve blocker ${blocked.id}`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0,
  };
}

/** CTO sprint escalation review (Spec 21). */
async function handleCtoEscalationReview(
  ctx: AgentBeatContext,
  _action: ChecklistAction,
  beatId: string,
  _finish: FinishFn,
): Promise<HandlerResult> {
  return executeCtoBeatEscalationReview(ctx, beatId);
}

/** CTO escalation timeout safety valve. */
async function handleCtoEscalationForceComplete(
  _ctx: AgentBeatContext,
  action: ChecklistAction,
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  startBeatTokenAccumulator(beatId);
  // Spec 31 Phase 7.B.4 — read via canonical-backed view.
  const companyId = requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);
  const sprintId = snapshot.company.currentSprintId;
  if (!sprintId) {
    finish("completed", "No active sprint", 0);
    return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }
  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  if (sprint?.status !== "reviewing") {
    finish("completed", "Sprint not in reviewing state", 0);
    return { summary: "Sprint not in reviewing state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  emitEmployeeActivity("cto", "transition", `${shortBeat(beatId)}: force-completing Sprint ${sprint.number}`, {
    beatId, detail: { reason: action.detail },
  });

  await finalizeSprintCompletion(sprintId);

  finish("completed", `CTO force-completed Sprint ${sprint.number} (escalation timeout)`, 1);
  return {
    summary: `CTO escalation timeout: force-completed Sprint ${sprint.number}`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0,
  };
}

/** Tester sprint review — run tester verification (Spec 21). */
async function handleRunTesterVerification(
  ctx: AgentBeatContext,
  _action: ChecklistAction,
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  startBeatTokenAccumulator(beatId);
  const res = await executeSprintReviewVerification(ctx, beatId);
  finish("completed", "tester verification", res.toolCalls);
  return res;
}

/** Tester sprint review — run final gate (Spec 21). */
async function handleRunFinalGate(
  ctx: AgentBeatContext,
  _action: ChecklistAction,
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  startBeatTokenAccumulator(beatId);
  const res = await executeSprintFinalGate(ctx, beatId);
  finish("completed", "final gate", res.toolCalls);
  return res;
}

/** Tester sprint review — retest after rework (Spec 21). */
async function handleRetestAfterRework(
  ctx: AgentBeatContext,
  _action: ChecklistAction,
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  startBeatTokenAccumulator(beatId);
  const res = await executeRetestAfterRework(ctx, beatId);
  finish("completed", "retest after rework", res.toolCalls);
  return res;
}

/** Meeting contribution — now collected directly by pipeline (Spec 24 Phase 4a). */
async function handleMeetingContribution(
  _ctx: AgentBeatContext,
  _action: ChecklistAction,
  _beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  finish("completed", "meeting contributions now collected by pipeline", 0);
  return {
    summary: `Meeting contribution skipped — collected directly by pipeline`,
    tokensUsed: 0, actionsCount: 0, toolCalls: 0,
  };
}

/** Generic LLM call — strategic roles reason about freeform action detail. */
async function handleFreeformLlmAction(
  _ctx: AgentBeatContext,
  action: ChecklistAction,
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  const role = _ctx.role;
  // Spec 35 — chat and heartbeat sessions are physically separate
  // (`getCeoChatSession` vs per-role `agentSessions`); the legacy
  // `isCeoStreaming()` skip-guard was removed alongside the rename.
  let registeredSessionId: string | null = null;
  try {
    // Spec 31 Phase 7.B.4 — view used for ensureAgentSession's
    // snapshot input and downstream agent lookups.
    const snapshot = await buildSnapshotView(_ctx.company.id);
    const soul = getRoleSoul(role);
    const beatCompanyId = _ctx.company.id;
    const session = await ensureAgentSession(snapshot, role, beatCompanyId);

    // Register session context so MCP tool calls can resolve identity
    // via findSoleActiveSessionContext / findActiveSessionContextByRole.
    registeredSessionId = session.sessionId;
    registerSessionContext({
      beatId,
      sessionId: session.sessionId,
      companyId: beatCompanyId,
      sprintId: _ctx.currentSprint?.id ?? null,
      role,
      trustBand: "standard",
      allowedTools: getAllowedArceusTools(role),
      startedAt: new Date().toISOString(),
      incomingHandoffs: [],
    });

    touchAgentSession(agentSessionKey(beatCompanyId, role), "working");
    emitEmployeeActivity(role, "working", `${shortBeat(beatId)}: ${action.suggestedAction}`, { beatId });

    const prompt = `You are the ${role.toUpperCase()}. Current situation: ${action.detail}. Action needed: ${action.suggestedAction}. Analyze and take the appropriate action. Respond with a structured summary of what you did.`;
    emitEmployeeActivity(role, "prompt", `${shortBeat(beatId)}: sending to LLM`, { beatId, detail: { promptLength: prompt.length } });
    const output = await runPromptText(role, session.sessionId, soul.systemPrompt + getAgentSkills(role), prompt, undefined, beatCompanyId);
    touchAgentSession(agentSessionKey(beatCompanyId, role), "idle");

    emitEmployeeActivity(role, "context", `${shortBeat(beatId)}: action completed`, {
      beatId, detail: { outputLength: output?.length ?? 0, outputPreview: output?.slice(0, 200) },
    });
    finish("completed", `${role} checklist action completed`, 1);
    return {
      summary: output?.slice(0, 500) || `${role} completed: ${action.suggestedAction}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
    };
  } catch (err) {
    touchAgentSession(agentSessionKey(_ctx.company.id, role), "idle");
    emitEmployeeActivity(role, "error", `${shortBeat(beatId)}: failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    finish("failed", `${role} checklist action failed`, 0);
    return {
      summary: `${role} checklist action failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  } finally {
    if (registeredSessionId) unregisterSessionContext(registeredSessionId);
  }
}

// ── Skills Lead action handlers (Spec 14 Phase 6) ──────────

/**
 * Shared setup + error wrapper for the 3 skills_lead handlers below.
 * Audit C11 (F-275/F-276) — was a single function with internal string
 * switch; split into 3 narrowly-typed handlers each calling this wrapper.
 */
async function withSkillsLeadContext(
  ctx: AgentBeatContext,
  beatId: string,
  fn: (env: { companyId: string; sprintId: string | null; snapshot: Awaited<ReturnType<typeof buildSnapshotView>> }) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  startBeatTokenAccumulator(beatId);
  const companyId = ctx.company.id;
  const snapshot = await buildSnapshotView(companyId);
  const sprintId = snapshot.company.currentSprintId ?? null;
  try {
    return await fn({ companyId, sprintId, snapshot });
  } catch (err) {
    emitEmployeeActivity("skills_lead", "error", `${shortBeat(beatId)}: failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    return {
      summary: `Skills Lead action failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }
}

/** Skills Lead — rewrite the worst active skill via the ATA pipeline. */
async function handleSkillsLeadMutateUnderperformer(
  ctx: AgentBeatContext,
  _action: ChecklistAction,
  beatId: string,
  _finish: FinishFn,
): Promise<HandlerResult> {
  return withSkillsLeadContext(ctx, beatId, async ({ companyId, sprintId, snapshot }) => {
    const underperformers = getUnderperformingSkills(companyId, skillsLeadPolicy.underperformerSuccessRate);
    if (underperformers.length === 0) {
      emitEmployeeActivity("skills_lead", "context", `${shortBeat(beatId)}: no underperformers`, { beatId });
      return { summary: "No underperforming skills detected", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }
    const worst = underperformers[0];
    emitEmployeeActivity("skills_lead", "working", `${shortBeat(beatId)}: mutating ${worst.name}`, { beatId });

    const mutation = await processTaskOutcome({
      taskId: `skills_lead_mutation_${worst.id}_${Date.now()}`,
      taskTitle: `Improve underperforming skill: ${worst.name}`,
      taskDescription: `Skill ${worst.name} has a ${(worst.successRate * 100).toFixed(0)}% success rate over ${worst.usageCount} uses. Identify root cause and propose an improved version.`,
      assignedRole: worst.role,
      companyId,
      status: "failed",
      iterationCount: 3,
      executionTrace: `Historical rate ${worst.successRate.toFixed(2)} across ${worst.usageCount} invocations.`,
    });

    if (!mutation) {
      return { summary: `No mutation produced for ${worst.name}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1 };
    }

    const skillsLeadAgent = getAgentByRole(snapshot, "skills_lead");
    const gov = await applyGovernanceToMutation({
      mutation, companyId, sprintId,
      proposerAgentId: skillsLeadAgent?.id ?? null,
      proposerRole: "skills_lead",
      estimatedCostCents: 2,
    });
    if (!gov.allowed) {
      return { summary: `Mutation for ${worst.name} refused: ${gov.reason}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1 };
    }

    swallowAndAudit("ata.pipeline.skills_lead", () => runATAPipeline(mutation.id), {
      companyId,
      agentRole: "skills_lead",
      beatId,
      detail: { mutationId: mutation.id, skillName: worst.name },
    });
    return { summary: `Proposed mutation ${mutation.id} for ${worst.name}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1 };
  });
}

/** Skills Lead — deprecate skills unused for N+ days. */
async function handleSkillsLeadDeprecateUnused(
  ctx: AgentBeatContext,
  _action: ChecklistAction,
  beatId: string,
  _finish: FinishFn,
): Promise<HandlerResult> {
  return withSkillsLeadContext(ctx, beatId, async ({ companyId }) => {
    const unused = getUnusedSkills(companyId, skillsLeadPolicy.unusedSkillStaleDays);
    if (unused.length === 0) {
      return { summary: "No unused skills to deprecate", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }
    const deprecated: string[] = [];
    for (const s of unused.slice(0, skillsLeadPolicy.maxBatchPerBeat)) {
      registryDeprecateSkill(s.id, `Unused for ${skillsLeadPolicy.unusedSkillStaleDays}+ days (0 invocations since ${s.lastUsedAt ?? "creation"})`);
      deprecated.push(s.name);
      auditAgent(companyId, "skills_lead", "skill_deprecated", `Skills Lead deprecated unused skill ${s.name}`, {
        severity: "info", detail: { skillId: s.id, lastUsedAt: s.lastUsedAt },
      });
    }
    emitEmployeeActivity("skills_lead", "context", `${shortBeat(beatId)}: deprecated ${deprecated.length} skills`, { beatId });
    return { summary: `Deprecated ${deprecated.length} unused skills: ${deprecated.join(", ")}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: deprecated.length, toolCalls: 1 };
  });
}

/** Skills Lead — synthesize a new skill from a sprint pattern cluster. */
async function handleSkillsLeadFillSkillGap(
  ctx: AgentBeatContext,
  _action: ChecklistAction,
  beatId: string,
  _finish: FinishFn,
): Promise<HandlerResult> {
  return withSkillsLeadContext(ctx, beatId, async ({ companyId, sprintId, snapshot }) => {
    if (!sprintId) {
      return { summary: "No current sprint — skipping skill-gap fill", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }
    const candidates = analyzeSprintPatterns(companyId, sprintId, skillsLeadPolicy.patternClusterMinSize);
    if (candidates.length === 0) {
      return { summary: "No sprint skill gaps detected", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }
    let proposed = 0;
    let refused = 0;
    // Cap cluster proposals at the same per-beat batch limit as
    // deprecate_unused — both fan out to the ATA pipeline and we don't
    // want one beat to monopolise the LLM budget.
    for (const candidate of candidates.slice(0, skillsLeadPolicy.maxBatchPerBeat)) {
      try {
        const mutation = await proposeSkillFromCluster(candidate);
        const skillsLeadAgent = getAgentByRole(snapshot, "skills_lead");
        const gov = await applyGovernanceToMutation({
          mutation, companyId, sprintId,
          proposerAgentId: skillsLeadAgent?.id ?? null,
          proposerRole: "skills_lead",
          estimatedCostCents: 2,
        });
        if (!gov.allowed) { refused++; continue; }
        proposed++;
        swallowAndAudit("ata.pipeline.gap_fill", () => runATAPipeline(mutation.id), {
          companyId,
          agentRole: "skills_lead",
          beatId,
          detail: { mutationId: mutation.id, candidateClusterId: candidate.clusterId },
        });
      } catch (err) {
        console.warn(`[SkillsLead] fill_skill_gap failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { summary: `Proposed ${proposed} emergent skills, ${refused} refused by governance`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: proposed, toolCalls: proposed + refused };
  });
}
