// heartbeats/beat-executor.ts — Execute a task within beat context
//
// Vision: "The orchestrator builds a view of the world, wakes one agent,
// and gets out of the way.  The agent is the only thing that reasons."
//
// All roles go through the same code path:
//   create session → register context → send prompt with state
//   → agent reasons + acts via MCP tools → cleanup
//
// No dependency gate, no specialist routing, no role-specific post-processing.
// Agents call task_complete / artifact_create / task_block themselves.
import type { AgentBeatContext, CompanySnapshot, Task } from "@arceus/contracts";
import {
  getRoleSoul, buildTrustEvent, TRUST_CONFIG,
} from "@arceus/company-runtime";
import { ROLE_CONFIGS, ALL_ARCEUS_TOOLS } from "../../../../.opencode/agent/config.js";
import { buildBeatContext } from "../orchestration/beat-context-builder.js";
import { registerSessionContext, unregisterSessionContext } from "../orchestration/session-context.js";
import { ensureDeployment } from "../config/index.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import {
  emitGraphBeatStarted, emitGraphBeatCompleted, resolveActiveSprintId,
} from "../observability/graph-emitter.js";
import { startBeatTokenAccumulator, drainBeatTokenAccumulator } from "../infra/azure-openai.js";
import { createBeatSession, destroyBeatSession } from "../infra/opencode.js";
import { ensureAgentSession } from "../prompts/llm.js";
import { getSnapshot } from "../persistence/store.js";
import { cpUpdateTrustScore } from "../persistence/control-plane.js";
import { buildSpecialistTaskPrompt } from "../prompts/specialist.js";
import { buildDeveloperBeatPrompt } from "../prompts/developer.js";
import { runPromptText } from "../prompts/llm.js";
import { touchAgentSession } from "../agents/sessions.js";
import { buildSkillCatalog } from "../skills/catalog.js";
import { matchAndRecordSkills } from "../skills/classifier.js";
import { setTaskStatus } from "../tasks/mutations.js";
import { collectWorkspaceSnapshot, tryAutoPreview } from "../workspace/monitor.js";
import { scaffoldProductWorkspace } from "../workspace/scaffold.js";
import {
  agentSessions, eventBridgeStarted,
  setEventBridgeStarted, productDir,
} from "../orchestration/state.js";
import { buildCeoSprintPlanningPrompt } from "../prompts/ceo-sprint.js";
import { startEventBridge } from "./event-bridge.js";

// ── Beat prompt enrichment ─────────────────────────────────────────────────
// Appends task identity, dependency state, and tool-usage instructions
// so the agent can self-manage its lifecycle via MCP tools.
function enrichPromptWithBeatContext(
  basePrompt: string,
  task: Task,
  snapshot: CompanySnapshot,
): string {
  const sections = [basePrompt];

  // Task ID — agents need this for task_complete / task_update_progress
  sections.push(`\n# Task Metadata\nTask ID: \`${task.id}\``);

  // Dependency state — agents reason about whether to proceed
  if (task.dependsOnTaskIds.length > 0) {
    const depLines = task.dependsOnTaskIds.map((depId) => {
      const dep = snapshot.tasks.find((t) => t.id === depId);
      return dep
        ? `- "${dep.title}" (${dep.assignedRole}): **${dep.status}**`
        : `- unknown (${depId})`;
    });
    const unmetCount = task.dependsOnTaskIds.filter((depId) => {
      const dep = snapshot.tasks.find((t) => t.id === depId);
      return !dep || dep.status !== "completed";
    }).length;

    sections.push(`\n# Dependencies\nThis task depends on:\n${depLines.join("\n")}`);
    if (unmetCount > 0) {
      sections.push(
        `\n⚠️ ${unmetCount} dependency(ies) not yet completed.`,
        "If you cannot make meaningful progress, call `task_block` and explain why.",
        "If you CAN make partial progress (e.g. define scope, draft structure), proceed and report via `task_update_progress`.",
      );
    }
  }

  // Tool-usage instructions — agent-managed lifecycle
  sections.push(
    "\n# Agent Lifecycle — USE YOUR TOOLS",
    "You have MCP tools for managing your work. You MUST use them:",
    `- \`task_update_progress\` (taskId="${task.id}") — report what you did`,
    `- \`artifact_create\` — save your output as a durable artifact (plan, spec, report, code)`,
    `- \`task_complete\` (taskId="${task.id}") — call this when you are DONE with the task`,
    `- \`task_block\` (taskId="${task.id}") — call this if you cannot proceed`,
    "",
    "**You MUST call `task_complete` when your work is finished.** The system does NOT auto-complete tasks.",
    "**You MUST call `artifact_create`** to persist any meaningful output (specs, plans, reports).",
  );

  return sections.join("\n");
}

/**
 * Execute a single task within a heartbeat cycle.
 * All roles go through OpenCode with MCP tools.
 * The agent reasons about its task, acts via tools, and calls
 * task_complete when done. Returns execution metrics.
 */
export async function executeBeatTask(
  ctx: AgentBeatContext,
  taskId: string,
  beatId: string,
): Promise<{ summary: string; tokensUsed: number; actionsCount: number; toolCalls: number; completed: boolean }> {
  // Ensure the SSE event bridge is running so runPromptText() completion
  // promises resolve (session.idle / session.error events).
  if (!eventBridgeStarted) {
    startEventBridge().catch(() => {});
    setEventBridgeStarted(true);
  }

  startBeatTokenAccumulator(beatId);
  const snapshot = getSnapshot();
  const task = snapshot.tasks.find((t) => t.id === taskId);
  if (!task) {
    emitEmployeeActivity("system", "error", `Beat ${beatId}: task ${taskId} not found in snapshot`, { beatId, detail: { taskId, role: ctx.role } });
    return { summary: `Task ${taskId} not found`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false };
  }

  const role = ctx.role;

  // Spec 14 (progressive disclosure): pick relevant skills via an LLM classifier
  const availableSkillCount = buildSkillCatalog(role).length;
  const matchedSkillIds = await matchAndRecordSkills(role, `${task.title} ${task.description}`);

  emitEmployeeActivity(role, "context", `Beat ${beatId}: picked task "${task.title}" [${task.status}] priority=${task.priority} availableSkills=${availableSkillCount} appliedSkills=${matchedSkillIds.length}`, {
    beatId, taskId, detail: { taskStatus: task.status, taskPriority: task.priority, assignedRole: task.assignedRole, definitionOfDone: task.definitionOfDone, availableSkillCount, appliedSkillIds: matchedSkillIds },
  });

  // All roles go through OpenCode — no specialist routing

  // ── Build prompt: role-specific context + unified beat enrichment ──
  const soul = getRoleSoul(role);

  // Developer infrastructure: scaffold workspace and collect file listing
  if (role === "developer") {
    const scaffoldResult = await scaffoldProductWorkspace(productDir, "product-app");
    if (scaffoldResult.scaffolded) {
      emitEmployeeActivity("developer", "info", `Beat ${beatId}: workspace scaffolded (Vite + React + Tailwind + shadcn/ui)`, { beatId, taskId });
    } else if (scaffoldResult.error) {
      emitEmployeeActivity("developer", "info", `Beat ${beatId}: scaffold skipped/partial: ${scaffoldResult.error}`, { beatId, taskId });
    }
  }
  const existingFileList = role === "developer"
    ? Array.from((await collectWorkspaceSnapshot()).keys()).sort()
    : undefined;

  const basePrompt = role === "ceo"
    ? buildCeoSprintPlanningPrompt(task, snapshot)
    : role === "developer"
      ? buildDeveloperBeatPrompt(task, existingFileList)
      : buildSpecialistTaskPrompt(task);
  const taskPrompt = enrichPromptWithBeatContext(basePrompt, task, snapshot);
  // ── Tools from ROLE_CONFIGS — includes built-ins + Arceus MCP tools ──
  // ROLE_CONFIGS uses unprefixed Arceus tool names (e.g. "sprint_create"),
  // but OpenCode names MCP tools as "<server>_<tool>" (e.g. "arceus_sprint_create").
  // Add the prefixed variants so OpenCode's tool whitelist includes MCP tools.
  const rawTools = ROLE_CONFIGS[role].tools;
  const tools: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(rawTools)) {
    tools[name] = enabled;
    // Mirror Arceus tool entries with the "arceus_" prefix OpenCode uses
    if ((ALL_ARCEUS_TOOLS as readonly string[]).includes(name)) {
      tools[`arceus_${name}`] = enabled;
    }
  }

  let beatViolationCount = 0;
  let beatSession: import("@opencode-ai/sdk").Session | null = null;
  // Ensure agentSessions entry exists so the SSE event bridge can
  // resolve this role via resolveRoleBySessionId() and detect session.idle.
  if (!agentSessions.has(role)) {
    await ensureAgentSession(snapshot, role);
  }
  const beatAgentState = agentSessions.get(role);
  let previousSessionId: string | undefined;
  const beatStartTime = Date.now();
  const beatSprintId = task.sprintId ?? resolveActiveSprintId();

  emitEmployeeActivity(role, "context", `Beat ${beatId}: prompt constructed (${taskPrompt.length} chars), tools=${tools ? Object.keys(tools).filter(k => (tools as any)[k]).join(",") : "none"}`, {
    beatId, taskId, detail: { promptLength: taskPrompt.length, tools: tools ? Object.keys(tools).filter(k => (tools as any)[k]) : [], promptType: role === "developer" ? "developer_build" : "specialist_text" },
  });

  try {
    beatSession = await createBeatSession(role, beatId);
    // Register session context so the plugin can enforce tool governance
    const beatCtx = await buildBeatContext(role, snapshot.company.id, beatId, beatSession.id);
    registerSessionContext(beatCtx);
    emitEmployeeActivity(role, "context", `Beat ${beatId}: session created ${beatSession.id}, allowedTools=[${beatCtx.allowedTools.join(",")}]`, { beatId, detail: { sessionId: beatSession.id, allowedTools: beatCtx.allowedTools } });
    previousSessionId = beatAgentState?.sessionId;
    if (beatAgentState) beatAgentState.sessionId = beatSession.id;
    touchAgentSession(role, "working");
    setTaskStatus(task.id, "in_progress");
    emitEmployeeActivity(role, "working", `Beat ${beatId}: executing "${task.title}"`, { taskId, beatId });

    emitEmployeeActivity(role, "prompt", `Beat ${beatId}: sending prompt to OpenCode (model=${ensureDeployment("workerDeployment")})`, {
      beatId, taskId, detail: { model: ensureDeployment("workerDeployment"), sessionId: beatSession.id },
    });
    if (beatSprintId) {
      emitGraphBeatStarted(beatSprintId, taskId, beatId, role, task.kind === "implementation" ? "execute_task" : task.kind, taskPrompt);
    }

    const output = await runPromptText(role, beatSession.id, soul.systemPrompt, taskPrompt, tools, matchedSkillIds);

    touchAgentSession(role, "idle");

    const tokensUsed = drainBeatTokenAccumulator(beatId);
    emitEmployeeActivity(role, "context", `Beat ${beatId}: prompt complete — ${tokensUsed} tokens, output=${(output?.length ?? 0)} chars`, {
      beatId, taskId, detail: { tokensUsed, outputLength: output?.length ?? 0, outputPreview: output?.slice(0, 200) },
    });

    // ── Post-execution: check if agent completed the task via tools ──
    const updated = getSnapshot().tasks.find((t) => t.id === taskId);
    const completed = updated?.status === "completed";

    if (role === "developer") {
      emitEmployeeActivity("system", "preview", `Beat ${beatId}: developer beat done — checking auto-preview`, { beatId });
      tryAutoPreview().catch(() => {});
    }

    // ── Governance: trust lifecycle (Spec 13 Step 10) ──
    if (completed) {
      const completionEvent = buildTrustEvent(ctx.agentId, "task_completed", `Beat ${beatId}: ${task.title}`, new Date().toISOString());
      await cpUpdateTrustScore(completionEvent);
    }
    if (beatViolationCount === 0) {
      const complianceEvent = buildTrustEvent(ctx.agentId, "manual_adjustment", `Beat ${beatId}: clean beat compliance bonus`, new Date().toISOString(), TRUST_CONFIG.complianceBonus);
      await cpUpdateTrustScore(complianceEvent);
    }
    emitEmployeeActivity(role, "decision", `Beat ${beatId}: trust lifecycle updated — ${completed ? "task_completed" : "beat_done"}${beatViolationCount === 0 ? " + compliance_bonus" : ""} (violations=${beatViolationCount})`, {
      beatId, taskId, detail: { beatViolationCount, taskCompleted: completed },
    });

    if (beatSprintId) {
      emitGraphBeatCompleted(beatSprintId, taskId, beatId, completed ? "completed" : "in_progress", output?.slice(0, 300), 1, Date.now() - beatStartTime);
    }

    return {
      summary: output?.slice(0, 500) || `${role} worked on ${task.title}`,
      tokensUsed, actionsCount: 1, toolCalls: 1, completed,
    };
  } catch (err) {
    touchAgentSession(role, "idle");
    emitEmployeeActivity(role, "error", `Beat ${beatId}: execution failed — ${err instanceof Error ? err.message : String(err)}`, {
      beatId, taskId, detail: { error: err instanceof Error ? err.message : String(err) },
    });

    if (beatSprintId) {
      emitGraphBeatCompleted(beatSprintId, taskId, beatId, "failed", err instanceof Error ? err.message : String(err), 0, Date.now() - beatStartTime);
    }

    const failEvent = buildTrustEvent(ctx.agentId, "task_failed", `Beat ${beatId}: ${err instanceof Error ? err.message : "unknown error"}`, new Date().toISOString());
    cpUpdateTrustScore(failEvent).catch(() => {});

    return {
      summary: `Beat task execution failed: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false,
    };
  } finally {
    if (previousSessionId && beatAgentState) {
      beatAgentState.sessionId = previousSessionId;
    }
    if (beatSession) {
      unregisterSessionContext(beatSession.id);
      destroyBeatSession(beatSession.id).catch(() => {});
    }
  }
}


