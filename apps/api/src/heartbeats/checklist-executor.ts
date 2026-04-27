// heartbeats/checklist-executor.ts — Execute a checklist-driven action when no task exists
import type { AgentBeatContext, AgentIdentity } from "@arceus/contracts";
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
import {
  emitGraphBeatStarted, emitGraphBeatCompleted, resolveActiveSprintId,
} from "../observability/graph-emitter.js";
import { startBeatTokenAccumulator, drainBeatTokenAccumulator } from "../infra/azure-openai.js";
import { updateMeeting, updateSprint } from "../persistence/store.js";
import { requireActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { flush } from "../persistence/store.js";
import { ensureAgentSession } from "../prompts/llm.js";
import { runPromptText } from "../prompts/llm.js";
import { touchAgentSession } from "../agents/sessions.js";
import { isCeoStreaming } from "../agents/chat.js";
import { applyGovernanceToMutation } from "../skills/governance.js";
import { eventBridgeStarted } from "../orchestration/state.js";
import { createWorkflowTask } from "@arceus/task-engine";
import { upsertTask } from "../persistence/store.js";
import { checkSprintCompletion } from "../sprints/lifecycle.js";
import { finalizeSprintCompletion } from "../sprints/lifecycle.js";
import {
  executeSprintReviewVerification, executeSprintFinalGate,
  executeRetestAfterRework, executeCtoBeatEscalationReview,
} from "../sprints/review.js";
import { startEventBridge } from "./event-bridge.js";

type HandlerResult = { summary: string; tokensUsed: number; actionsCount: number; toolCalls: number };
type FinishFn = (status: "completed" | "failed", summary: string, toolCalls: number) => void;
type ChecklistHandler = (
  ctx: AgentBeatContext,
  action: { detail: string; suggestedAction: string },
  beatId: string,
  finish: FinishFn,
) => Promise<HandlerResult>;

/**
 * Action-prefix dispatch table. Replaces the old `if (role === "X")` chain.
 * Order matters — first match wins. Specific actions before broader prefixes.
 * The orchestrator is now role-neutral: it routes by what the checklist asked for,
 * not by who the agent is. See plans/agent-redesign/00-vision.md blocker #3.
 */
const CHECKLIST_HANDLERS: Array<{ matches: (action: { suggestedAction: string }) => boolean; handle: ChecklistHandler }> = [
  { matches: (a) => a.suggestedAction === "sprint_review:cto_escalation_review", handle: handleCtoEscalationReview },
  { matches: (a) => a.suggestedAction === "sprint_review:cto_escalation_force_complete", handle: handleCtoEscalationForceComplete },
  { matches: (a) => a.suggestedAction.startsWith("sprint_review:"), handle: handleTesterSprintReview },
  { matches: (a) => a.suggestedAction.startsWith("skills_lead:"), handle: handleSkillsLeadDispatch },
  { matches: (a) => a.suggestedAction.startsWith("meeting_contribution:"), handle: handleMeetingContribution },
  { matches: (a) => /\bpropose (next|new) sprint\b/i.test(a.suggestedAction) || /^plan sprint\b/i.test(a.suggestedAction), handle: handleCreateSprintPlanningTask },
];

/**
 * Execute a checklist-driven action when no task is assigned.
 * Dispatches by action prefix (not by role) — the orchestrator stays neutral.
 */
export async function executeChecklistAction(
  ctx: AgentBeatContext,
  action: { detail: string; suggestedAction: string },
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

  // Ensure the SSE event bridge is running. startEventBridge owns the
  // started-flag — sets it true only after the SSE handshake succeeds, and
  // resets it on disconnect (C3 — F-273/274/290 fix).
  if (!eventBridgeStarted) {
    startEventBridge().catch(() => {});
  }

  emitEmployeeActivity(role, "decision", `${shortBeat(beatId)}: ${action.suggestedAction}`, {
    beatId, detail: { suggestedAction: action.suggestedAction, actionDetail: action.detail },
  });

  // ── Dispatch by action prefix (no role gates) ──
  for (const { matches, handle } of CHECKLIST_HANDLERS) {
    if (matches(action)) {
      return handle(ctx, action, beatId, finish);
    }
  }

  // ── Fallback: strategic roles reason about freeform actions via LLM ──
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

/** Create a governance task so the responsible agent plans the next sprint. */
async function handleCreateSprintPlanningTask(
  _ctx: AgentBeatContext,
  _action: { detail: string; suggestedAction: string },
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  if (isCeoStreaming()) {
    emitEmployeeActivity("ceo", "info", `${shortBeat(beatId)}: skipped — live chat active`, { beatId });
    finish("completed", "CEO skipped — streaming", 0);
    return { summary: "CEO skipped — live chat streaming in progress", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  // Ensure any finished sprint is properly marked complete first
  await checkSprintCompletion();

  // Spec 31 Phase 7.B.4 — read snapshot via canonical-backed view.
  const companyId = requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);
  const nextNum = (snapshot.company.currentSprintNumber ?? 0) + 1;

  // Guard: don't create duplicate planning tasks
  const alreadyExists = snapshot.tasks.some(
    (t) => t.assignedRole === "ceo" && t.title.startsWith("Plan Sprint") &&
      ["created", "planned", "in_progress"].includes(t.status),
  );
  if (alreadyExists) {
    finish("completed", "Sprint planning task already exists", 0);
    return { summary: "Sprint planning task already exists — CEO will pick it up", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }

  const task = createWorkflowTask(
    snapshot, "implementation", "ceo",
    `Plan Sprint ${nextNum}`,
    `Analyze company state, previous sprint results, and team capacity. Use the sprint_create tool to create Sprint ${nextNum} with a clear goal and actionable tasks assigned to the right roles.`,
    "The company needs a new sprint plan.",
    "A new sprint created via sprint_create with goal, tasks, dependencies, and role assignments.",
    [`Sprint ${nextNum} created with sprint_create tool`, "All tasks have assigned roles", "Dependencies are specified"],
    "critical",
    "planned",
    null, // no sprint yet
  );
  upsertTask(task);

  emitEmployeeActivity("ceo", "transition", `${shortBeat(beatId)}: created task "${task.title}"`, { beatId, taskId: task.id });
  finish("completed", `Created sprint planning task: ${task.title}`, 0);
  return {
    summary: `Created governance task "${task.title}" for CEO — agent will reason and call sprint_create`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0,
  };
}

/** CTO sprint escalation review (Spec 21). */
async function handleCtoEscalationReview(
  ctx: AgentBeatContext,
  _action: { detail: string; suggestedAction: string },
  beatId: string,
  _finish: FinishFn,
): Promise<HandlerResult> {
  return executeCtoBeatEscalationReview(ctx, beatId);
}

/** CTO escalation timeout safety valve. */
async function handleCtoEscalationForceComplete(
  _ctx: AgentBeatContext,
  action: { detail: string; suggestedAction: string },
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
  if (!sprint || sprint.status !== "reviewing") {
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

/** Tester sprint review actions (Spec 21). */
async function handleTesterSprintReview(
  ctx: AgentBeatContext,
  action: { detail: string; suggestedAction: string },
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  startBeatTokenAccumulator(beatId);
  const reviewAction = action.suggestedAction;

  if (reviewAction === "sprint_review:run_tester_verification") {
    const res = await executeSprintReviewVerification(ctx, beatId);
    finish("completed", "tester verification", res.toolCalls);
    return res;
  }
  if (reviewAction === "sprint_review:run_final_gate") {
    const res = await executeSprintFinalGate(ctx, beatId);
    finish("completed", "final gate", res.toolCalls);
    return res;
  }
  if (reviewAction === "sprint_review:retest_after_rework") {
    const res = await executeRetestAfterRework(ctx, beatId);
    finish("completed", "retest after rework", res.toolCalls);
    return res;
  }

  finish("completed", `Unknown review action: ${reviewAction}`, 0);
  return {
    summary: `Unknown sprint review action: ${reviewAction}`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
  };
}

/** Skills Lead governance dispatcher (Spec 14 Phase 6). */
async function handleSkillsLeadDispatch(
  ctx: AgentBeatContext,
  action: { detail: string; suggestedAction: string },
  beatId: string,
  _finish: FinishFn,
): Promise<HandlerResult> {
  return executeSkillsLeadAction(ctx, beatId, action.suggestedAction);
}

/** Meeting contribution — now collected directly by pipeline (Spec 24 Phase 4a). */
async function handleMeetingContribution(
  _ctx: AgentBeatContext,
  _action: { detail: string; suggestedAction: string },
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
  action: { detail: string; suggestedAction: string },
  beatId: string,
  finish: FinishFn,
): Promise<HandlerResult> {
  const role = _ctx.role;
  try {
    // Spec 31 Phase 7.B.4 — view used for ensureAgentSession's
    // snapshot input and downstream agent lookups.
    const snapshot = await buildSnapshotView(_ctx.company.id);
    const soul = getRoleSoul(role);
    const session = await ensureAgentSession(snapshot, role);
    touchAgentSession(role, "working");
    emitEmployeeActivity(role, "working", `${shortBeat(beatId)}: ${action.suggestedAction}`, { beatId });

    const prompt = `You are the ${role.toUpperCase()}. Current situation: ${action.detail}. Action needed: ${action.suggestedAction}. Analyze and take the appropriate action. Respond with a structured summary of what you did.`;
    emitEmployeeActivity(role, "prompt", `${shortBeat(beatId)}: sending to LLM`, { beatId, detail: { promptLength: prompt.length } });
    const output = await runPromptText(role, session.sessionId, soul.systemPrompt + getAgentSkills(role), prompt);
    touchAgentSession(role, "idle");

    emitEmployeeActivity(role, "context", `${shortBeat(beatId)}: action completed`, {
      beatId, detail: { outputLength: output?.length ?? 0, outputPreview: output?.slice(0, 200) },
    });
    finish("completed", `${role} checklist action completed`, 1);
    return {
      summary: output?.slice(0, 500) || `${role} completed: ${action.suggestedAction}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
    };
  } catch (err) {
    touchAgentSession(role, "idle");
    emitEmployeeActivity(role, "error", `${shortBeat(beatId)}: failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    finish("failed", `${role} checklist action failed`, 0);
    return {
      summary: `${role} checklist action failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }
}

// ── Skills Lead action handlers (Spec 14 Phase 6) ──────────

/** Handle Skills Lead governance actions: mutate underperformers, deprecate unused, fill gaps. */
async function executeSkillsLeadAction(
  _ctx: AgentBeatContext,
  beatId: string,
  suggestedAction: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  startBeatTokenAccumulator(beatId);
  // Spec 31 Phase 7.B.4 — companyId from beat ctx, snapshot view for agent lookups below.
  const companyId = _ctx.company.id;
  const snapshot = await buildSnapshotView(companyId);
  const sprintId = snapshot.company.currentSprintId ?? null;

  try {
    // ── mutate_underperformer: rewrite the worst active skill ──
    if (suggestedAction === "skills_lead:mutate_underperformer") {
      const underperformers = getUnderperformingSkills(companyId, skillsLeadPolicy.underperformerSuccessRate);
      if (underperformers.length === 0) {
        emitEmployeeActivity("skills_lead", "context", `${shortBeat(beatId)}: no underperformers`, { beatId });
        return { summary: "No underperforming skills detected", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
      }
      const worst = underperformers[0]!;
      emitEmployeeActivity("skills_lead", "working", `${shortBeat(beatId)}: mutating ${worst.name}`, { beatId });

      const mutation = await processTaskOutcome({
        taskId: `skills_lead_mutation_${worst.id}_${Date.now()}`,
        taskTitle: `Improve underperforming skill: ${worst.name}`,
        taskDescription: `Skill ${worst.name} has a ${(worst.successRate * 100).toFixed(0)}% success rate over ${worst.usageCount} uses. Identify root cause and propose an improved version.`,
        assignedRole: worst.role as AgentIdentity["role"],
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

      runATAPipeline(mutation.id).catch((err: unknown) => {
        console.warn(`[ATA] Skills Lead pipeline error for ${mutation.id}: ${err instanceof Error ? err.message : err}`);
      });
      return { summary: `Proposed mutation ${mutation.id} for ${worst.name}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1 };
    }

    // ── deprecate_unused: flip unused skills to deprecated ──
    if (suggestedAction === "skills_lead:deprecate_unused") {
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
    }

    // ── fill_skill_gap: synthesize skill from sprint cluster ──
    if (suggestedAction === "skills_lead:fill_skill_gap") {
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
          runATAPipeline(mutation.id).catch((err: unknown) => {
            console.warn(`[ATA] Skills Lead gap-fill error for ${mutation.id}: ${err instanceof Error ? err.message : err}`);
          });
        } catch (err) {
          console.warn(`[SkillsLead] fill_skill_gap failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      return { summary: `Proposed ${proposed} emergent skills, ${refused} refused by governance`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: proposed, toolCalls: proposed + refused };
    }

    return { summary: `Unknown Skills Lead action: ${suggestedAction}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  } catch (err) {
    emitEmployeeActivity("skills_lead", "error", `${shortBeat(beatId)}: failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    return { summary: `Skills Lead action failed: ${err instanceof Error ? err.message : String(err)}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }
}
