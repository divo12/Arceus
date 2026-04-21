// heartbeats/checklist-executor.ts — Execute a checklist-driven action when no task exists
import type { AgentBeatContext, AgentIdentity } from "@arceus/contracts";
import {
  getRoleSoul, getAgentSkills,
  processTaskOutcome, runATAPipeline,
  getUnderperformingSkills, getUnusedSkills, analyzeSprintPatterns,
  proposeSkillFromCluster, deprecateSkill as registryDeprecateSkill,
} from "@arceus/company-runtime";
import { getAgentByRole } from "@arceus/task-engine";
import { emitEmployeeActivity } from "../observability/activity.js";
import { auditAgent } from "../observability/audit-ledger.js";
import {
  emitGraphBeatStarted, emitGraphBeatCompleted, resolveActiveSprintId,
} from "../observability/graph-emitter.js";
import { startBeatTokenAccumulator, drainBeatTokenAccumulator } from "../infra/azure-openai.js";
import { getSnapshot, updateMeeting, updateSprint } from "../persistence/store.js";
import { flush } from "../persistence/store.js";
import { ensureAgentSession } from "../prompts/llm.js";
import { runPromptText } from "../prompts/llm.js";
import { touchAgentSession } from "../agents/sessions.js";
import { isCeoStreaming } from "../agents/chat.js";
import { applyGovernanceToMutation } from "../skills/governance.js";
import {
  eventBridgeStarted, setEventBridgeStarted,
} from "../orchestration/state.js";
import { createWorkflowTask } from "@arceus/task-engine";
import { upsertTask } from "../persistence/store.js";
import { checkSprintCompletion } from "../sprints/lifecycle.js";
import { finalizeSprintCompletion } from "../sprints/lifecycle.js";
import {
  executeSprintReviewVerification, executeSprintFinalGate,
  executeRetestAfterRework, executeCtoBeatEscalationReview,
} from "../sprints/review.js";
import { startEventBridge } from "./event-bridge.js";

/**
 * Execute a checklist-driven action when no task is assigned.
 * Handles sprint proposals, escalation reviews, skill governance,
 * and meeting contributions based on the suggested action type.
 */
export async function executeChecklistAction(
  ctx: AgentBeatContext,
  action: { detail: string; suggestedAction: string },
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  const role = ctx.role;

  // ── Graph instrumentation (Spec 22) — beat wrapping checklist action ──
  const clBeatId = `cl_${beatId}`;
  const clSprintId = ctx.currentSprint?.id ?? resolveActiveSprintId() ?? "";
  const clBeatStart = Date.now();
  if (clSprintId) {
    emitGraphBeatStarted(clSprintId, clSprintId, clBeatId, role, `checklist:${action.suggestedAction}`, action.detail?.slice(0, 200));
  }
  const finishClBeat = (status: "completed" | "failed", summary: string, toolCalls: number) => {
    if (clSprintId) emitGraphBeatCompleted(clSprintId, clSprintId, clBeatId, status, summary, toolCalls, Date.now() - clBeatStart);
  };

  // Ensure the SSE event bridge is running
  if (!eventBridgeStarted) {
    startEventBridge().catch(() => {});
    setEventBridgeStarted(true);
  }

  emitEmployeeActivity(role, "decision", `Beat ${beatId}: checklist action dispatched — "${action.suggestedAction}"`, {
    beatId, detail: { suggestedAction: action.suggestedAction, actionDetail: action.detail },
  });

  // ── CEO: create a governance task so the CEO agent plans the next sprint ──
  if (role === "ceo" && action.suggestedAction.toLowerCase().includes("sprint")) {
    if (isCeoStreaming()) {
      emitEmployeeActivity("ceo", "info", `Beat ${beatId}: CEO skipped — live chat streaming`, { beatId });
      finishClBeat("completed", "CEO skipped — streaming", 0);
      return { summary: "CEO skipped — live chat streaming in progress", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }

    // Ensure any finished sprint is properly marked complete first
    await checkSprintCompletion();

    const snapshot = getSnapshot();
    const nextNum = (snapshot.company.currentSprintNumber ?? 0) + 1;

    // Guard: don't create duplicate planning tasks
    const alreadyExists = snapshot.tasks.some(
      (t) => t.assignedRole === "ceo" && t.title.startsWith("Plan Sprint") &&
        ["created", "planned", "in_progress"].includes(t.status),
    );
    if (alreadyExists) {
      finishClBeat("completed", "Sprint planning task already exists", 0);
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

    emitEmployeeActivity("ceo", "transition", `Beat ${beatId}: created governance task "${task.title}" — CEO will plan the sprint on next beat`, { beatId, taskId: task.id });
    finishClBeat("completed", `Created sprint planning task: ${task.title}`, 0);
    return {
      summary: `Created governance task "${task.title}" for CEO — agent will reason and call sprint_create`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0,
    };
  }

  // ── CTO: sprint escalation review (Spec 21) ──
  if (role === "cto" && action.suggestedAction === "sprint_review:cto_escalation_review") {
    return executeCtoBeatEscalationReview(ctx, beatId);
  }

  // ── CTO: escalation timeout safety valve ──
  if (role === "cto" && action.suggestedAction === "sprint_review:cto_escalation_force_complete") {
    startBeatTokenAccumulator(beatId);
    const snapshot = getSnapshot();
    const sprintId = snapshot.company.currentSprintId;
    if (!sprintId) {
      finishClBeat("completed", "No active sprint", 0);
      return { summary: "No active sprint", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }
    const sprint = snapshot.sprints.find((s) => s.id === sprintId);
    if (!sprint || sprint.status !== "reviewing") {
      finishClBeat("completed", "Sprint not in reviewing state", 0);
      return { summary: "Sprint not in reviewing state", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
    }

    emitEmployeeActivity("cto", "transition", `Beat ${beatId}: escalation timeout — force-completing Sprint ${sprint.number}`, {
      beatId, detail: { reason: action.detail },
    });

    await finalizeSprintCompletion(sprintId);

    finishClBeat("completed", `CTO force-completed Sprint ${sprint.number} (escalation timeout)`, 1);
    return {
      summary: `CTO escalation timeout: force-completed Sprint ${sprint.number}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 0,
    };
  }

  // ── PM: scope triage, board response ──
  if (role === "pm" || role === "cto") {
    try {
      const snapshot = getSnapshot();
      const soul = getRoleSoul(role);
      const session = await ensureAgentSession(snapshot, role);
      touchAgentSession(role, "working");
      emitEmployeeActivity(role, "working", `Beat ${beatId}: ${action.suggestedAction}`, { beatId });

      const prompt = `You are the ${role.toUpperCase()}. Current situation: ${action.detail}. Action needed: ${action.suggestedAction}. Analyze and take the appropriate action. Respond with a structured summary of what you did.`;
      emitEmployeeActivity(role, "prompt", `Beat ${beatId}: sending checklist-action prompt (${prompt.length} chars)`, { beatId, detail: { promptLength: prompt.length } });
      const output = await runPromptText(role, session.sessionId, soul.systemPrompt + getAgentSkills(role), prompt);
      touchAgentSession(role, "idle");

      emitEmployeeActivity(role, "context", `Beat ${beatId}: checklist action completed — output=${(output?.length ?? 0)} chars`, {
        beatId, detail: { outputLength: output?.length ?? 0, outputPreview: output?.slice(0, 200) },
      });
      finishClBeat("completed", `${role} checklist action completed`, 1);
      return {
        summary: output?.slice(0, 500) || `${role} completed: ${action.suggestedAction}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 1, toolCalls: 1,
      };
    } catch (err) {
      touchAgentSession(role, "idle");
      emitEmployeeActivity(role, "error", `Beat ${beatId}: ${role} checklist action failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
      finishClBeat("failed", `${role} checklist action failed`, 0);
      return {
        summary: `${role} checklist action failed: ${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
      };
    }
  }

  // ── Tester: sprint review actions (Spec 21) ──
  if (role === "tester" && action.suggestedAction.startsWith("sprint_review:")) {
    startBeatTokenAccumulator(beatId);
    const reviewAction = action.suggestedAction;

    if (reviewAction === "sprint_review:run_tester_verification") {
      const res = await executeSprintReviewVerification(ctx, beatId);
      finishClBeat("completed", "tester verification", res.toolCalls);
      return res;
    }
    if (reviewAction === "sprint_review:run_final_gate") {
      const res = await executeSprintFinalGate(ctx, beatId);
      finishClBeat("completed", "final gate", res.toolCalls);
      return res;
    }
    if (reviewAction === "sprint_review:retest_after_rework") {
      const res = await executeRetestAfterRework(ctx, beatId);
      finishClBeat("completed", "retest after rework", res.toolCalls);
      return res;
    }

    finishClBeat("completed", `Unknown review action: ${reviewAction}`, 0);
    return {
      summary: `Unknown sprint review action: ${reviewAction}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
    };
  }

  // ── Skills Lead: skill governance actions (Spec 14 Phase 6) ──
  if (role === "skills_lead" && action.suggestedAction.startsWith("skills_lead:")) {
    return executeSkillsLeadAction(ctx, beatId, action.suggestedAction);
  }

  // ── Meeting contribution — now handled directly by pipeline (Spec 24 Phase 4a) ──
  if (action.suggestedAction.startsWith("meeting_contribution:")) {
    finishClBeat("completed", "meeting contributions now collected by pipeline", 0);
    return {
      summary: `Meeting contribution skipped — collected directly by pipeline`,
      tokensUsed: 0, actionsCount: 0, toolCalls: 0,
    };
  }

  // ── Fallback: log the action without executing ──
  emitEmployeeActivity(role, "info", `Beat ${beatId}: no handler for checklist action — "${action.suggestedAction}"`, { beatId });
  if (clSprintId) emitGraphBeatCompleted(clSprintId, clSprintId, clBeatId, "completed", `No handler: ${action.suggestedAction}`, 0, Date.now() - clBeatStart);
  return {
    summary: `${role}: ${action.suggestedAction} (no handler)`,
    tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0,
  };
}

// ── Skills Lead action handlers (Spec 14 Phase 6) ──────────

/** Handle Skills Lead governance actions: mutate underperformers, deprecate unused, fill gaps. */
async function executeSkillsLeadAction(
  _ctx: AgentBeatContext,
  beatId: string,
  suggestedAction: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number }> {
  startBeatTokenAccumulator(beatId);
  const snapshot = getSnapshot();
  const companyId = snapshot.company.id;
  const sprintId = snapshot.company.currentSprintId ?? null;

  try {
    // ── mutate_underperformer: rewrite the worst active skill ──
    if (suggestedAction === "skills_lead:mutate_underperformer") {
      const underperformers = getUnderperformingSkills(companyId, 0.6);
      if (underperformers.length === 0) {
        emitEmployeeActivity("skills_lead", "context", `Beat ${beatId}: no underperformers to mutate`, { beatId });
        return { summary: "No underperforming skills detected", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
      }
      const worst = underperformers[0]!;
      emitEmployeeActivity("skills_lead", "working", `Beat ${beatId}: proposing mutation for ${worst.name} (rate=${worst.successRate.toFixed(2)})`, { beatId });

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
      const unused = getUnusedSkills(companyId, 30);
      if (unused.length === 0) {
        return { summary: "No unused skills to deprecate", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
      }
      const deprecated: string[] = [];
      for (const s of unused.slice(0, 3)) {
        registryDeprecateSkill(s.id, `Unused for 30+ days (0 invocations since ${s.lastUsedAt ?? "creation"})`);
        deprecated.push(s.name);
        auditAgent(companyId, "skills_lead", "skill_deprecated", `Skills Lead deprecated unused skill ${s.name}`, {
          severity: "info", detail: { skillId: s.id, lastUsedAt: s.lastUsedAt },
        });
      }
      emitEmployeeActivity("skills_lead", "context", `Beat ${beatId}: deprecated ${deprecated.length} unused skills`, { beatId });
      return { summary: `Deprecated ${deprecated.length} unused skills: ${deprecated.join(", ")}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: deprecated.length, toolCalls: 1 };
    }

    // ── fill_skill_gap: synthesize skill from sprint cluster ──
    if (suggestedAction === "skills_lead:fill_skill_gap") {
      if (!sprintId) {
        return { summary: "No current sprint — skipping skill-gap fill", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
      }
      const candidates = analyzeSprintPatterns(companyId, sprintId, 3);
      if (candidates.length === 0) {
        return { summary: "No sprint skill gaps detected", tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
      }
      let proposed = 0;
      let refused = 0;
      for (const candidate of candidates.slice(0, 2)) {
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
    emitEmployeeActivity("skills_lead", "error", `Beat ${beatId}: Skills Lead action failed — ${err instanceof Error ? err.message : String(err)}`, { beatId });
    return { summary: `Skills Lead action failed: ${err instanceof Error ? err.message : String(err)}`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0 };
  }
}
