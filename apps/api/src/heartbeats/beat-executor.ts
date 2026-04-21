// heartbeats/beat-executor.ts — Execute a task within beat context (Spec 12 Phase 3)
import type { AgentBeatContext } from "@arceus/contracts";
import {
  getRoleSoul, buildTrustEvent, TRUST_CONFIG, getAgentSkills,
} from "@arceus/company-runtime";
import { getAgentByRole } from "@arceus/task-engine";
import { ROLE_CONFIGS, ALL_ARCEUS_TOOLS } from "../../../../.opencode/agent/config.js";
import { buildBeatContext } from "../orchestration/beat-context-builder.js";
import { registerSessionContext, unregisterSessionContext } from "../orchestration/session-context.js";
import { ensureDeployment } from "../config/index.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import {
  emitGraphBeatStarted, emitGraphBeatCompleted, resolveActiveSprintId,
} from "../observability/graph-emitter.js";
import { structuredCompletion, startBeatTokenAccumulator, drainBeatTokenAccumulator } from "../infra/azure-openai.js";
import { createBeatSession, destroyBeatSession } from "../infra/opencode.js";
import { getSnapshot } from "../persistence/store.js";
import { cpCommitTaskResult, cpUpdateTrustScore } from "../persistence/control-plane.js";
import { buildSpecialistTaskPrompt } from "../prompts/specialist.js";
import { buildDeveloperBeatPrompt } from "../prompts/developer.js";
import { runPromptText } from "../prompts/llm.js";
import { touchAgentSession } from "../agents/sessions.js";
import { isCeoStreaming } from "../agents/chat.js";
import { buildSkillCatalog } from "../skills/catalog.js";
import { matchAndRecordSkills } from "../skills/classifier.js";
import { executeSpecialistTask } from "../tasks/specialist-executor.js";
import {
  addArtifact, writeArtifactToWorkspace, appendTaskResult, attachArtifactToTask,
  setTaskStatus, appendTaskCommand, setTaskPreviewUrl,
} from "../tasks/mutations.js";
import { collectWorkspaceSnapshot, tryAutoPreview } from "../workspace/monitor.js";
import { scaffoldProductWorkspace } from "../workspace/scaffold.js";
import {
  agentSessions, activeExecution, eventBridgeStarted,
  setEventBridgeStarted, productDir,
  type Artifact,
} from "../orchestration/state.js";
import { buildCeoSprintPlanningPrompt } from "../prompts/ceo-sprint.js";
import { startEventBridge } from "./event-bridge.js";

/**
 * Execute a single task within a heartbeat cycle.
 * Routes to specialist executors, CEO governance, or OpenCode prompt
 * depending on the agent role. Returns execution metrics.
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

  // ── Dependency gate: skip tasks whose dependencies haven't completed ──
  if (task.dependsOnTaskIds.length > 0) {
    const unmetDeps = task.dependsOnTaskIds.filter((depId) => {
      const dep = snapshot.tasks.find((t) => t.id === depId);
      return !dep || dep.status !== "completed";
    });
    if (unmetDeps.length > 0) {
      const depDetails = unmetDeps.map((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return dep ? `"${dep.title}" [${dep.status}]` : `unknown(${depId})`;
      });
      emitEmployeeActivity(ctx.role, "decision", `Beat ${beatId}: skipping task "${task.title}" — ${unmetDeps.length} unmet dependency(ies): ${depDetails.join(", ")}`, { beatId, taskId });
      return { summary: `Skipped "${task.title}" — waiting on ${unmetDeps.length} dependencies`, tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false };
    }
  }

  const role = ctx.role;

  // Spec 14 (progressive disclosure): pick relevant skills via an LLM classifier
  const availableSkillCount = buildSkillCatalog(role).length;
  const matchedSkillIds = await matchAndRecordSkills(role, `${task.title} ${task.description}`);

  emitEmployeeActivity(role, "context", `Beat ${beatId}: picked task "${task.title}" [${task.status}] priority=${task.priority} availableSkills=${availableSkillCount} appliedSkills=${matchedSkillIds.length}`, {
    beatId, taskId, detail: { taskStatus: task.status, taskPriority: task.priority, assignedRole: task.assignedRole, definitionOfDone: task.definitionOfDone, availableSkillCount, appliedSkillIds: matchedSkillIds },
  });

  // Skip if CEO is actively chatting with the board (thin guard, not reasoning)
  if (role === "ceo" && isCeoStreaming()) {
    return {
      summary: "CEO beat skipped — live chat streaming in progress",
      tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false,
    };
  }

  // For specialist roles, delegate to existing executeSpecialistTask
  if (["tester", "ui_designer", "marketing", "skills_lead"].includes(role)) {
    emitEmployeeActivity(role, "decision", `Beat ${beatId}: routing to specialist executor`, { beatId, taskId });
    try {
      await executeSpecialistTask(taskId);
      const updated = getSnapshot().tasks.find((t) => t.id === taskId);
      return {
        summary: updated?.title || `${role} completed ${task.title}`,
        tokensUsed: drainBeatTokenAccumulator(beatId),
        actionsCount: 1,
        toolCalls: 1,
        completed: updated?.status === "completed",
      };
    } catch (err) {
      return {
        summary: `${role} task failed: ${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: drainBeatTokenAccumulator(beatId), actionsCount: 0, toolCalls: 0, completed: false,
      };
    }
  }

  // For CTO/PM/developer — run a single prompt cycle via runPromptText
  const soul = getRoleSoul(role);

  let preSnapshot: Map<string, number> | null = null;
  if (role === "developer") {
    const scaffoldResult = await scaffoldProductWorkspace(productDir, "product-app");
    if (scaffoldResult.scaffolded) {
      emitEmployeeActivity("developer", "info", `Beat ${beatId}: workspace scaffolded (Vite + React + Tailwind + shadcn/ui)`, { beatId, taskId });
    } else if (scaffoldResult.error) {
      emitEmployeeActivity("developer", "info", `Beat ${beatId}: scaffold skipped/partial: ${scaffoldResult.error}`, { beatId, taskId });
    }
    preSnapshot = await collectWorkspaceSnapshot();
  }
  const existingFileList = preSnapshot ? Array.from(preSnapshot.keys()).sort() : undefined;
  const taskPrompt = role === "ceo"
    ? buildCeoSprintPlanningPrompt(task, snapshot)
    : role === "developer"
      ? buildDeveloperBeatPrompt(task, existingFileList)
      : buildSpecialistTaskPrompt(task);
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

    // ── Post-execution: create artifacts & detect file changes ──
    const commitArtifactIds: string[] = [];
    let filesModified: string[] = [];

    if (role === "developer" && preSnapshot) {
      const postSnapshot = await collectWorkspaceSnapshot();
      const changed: string[] = [];
      for (const [file, mtime] of postSnapshot) {
        const prevMtime = preSnapshot.get(file);
        if (prevMtime === undefined || prevMtime !== mtime) {
          changed.push(file);
        }
      }
      filesModified = changed;

      if (changed.length > 0) {
        const meaningfulExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".css", ".scss", ".html"]);
        const meaningfulChanges = changed.filter((f) => {
          const ext = f.slice(f.lastIndexOf("."));
          return meaningfulExtensions.has(ext);
        });

        for (const f of changed) {
          appendTaskResult(task.id, `edited:${f}`);
        }
        emitEmployeeActivity(role, "context", `Beat ${beatId}: ${changed.length} file(s) modified (${meaningfulChanges.length} source): ${changed.slice(0, 10).join(", ")}`, {
          beatId, taskId, detail: { filesModified: changed, meaningfulCount: meaningfulChanges.length },
        });

        if (meaningfulChanges.length === 0) {
          emitEmployeeActivity(role, "info", `Beat ${beatId}: developer changed ${changed.length} file(s) but none are source code — task stays in_progress`, { beatId, taskId });
          appendTaskResult(task.id, `[${beatId}] only config/lock files changed — no source code written`);
          return {
            summary: `Developer beat changed ${changed.length} config files but no source code — task stays in_progress for retry`,
            tokensUsed, actionsCount: 1, toolCalls: 1, completed: false,
          };
        }
      } else {
        emitEmployeeActivity(role, "info", `Beat ${beatId}: developer produced NO file changes — task stays in_progress`, { beatId, taskId });
        appendTaskResult(task.id, `[${beatId}] no files changed`);
        const noChangeEvent = buildTrustEvent(ctx.agentId, "task_failed", `Beat ${beatId}: no files written`, new Date().toISOString());
        cpUpdateTrustScore(noChangeEvent).catch(() => {});
        return {
          summary: `Developer beat produced no file changes — task stays in_progress for retry`,
          tokensUsed, actionsCount: 1, toolCalls: 1, completed: false,
        };
      }
    } else if ((role === "cto" || role === "pm") && output) {
      const artifactKind: Artifact["kind"] = task.kind === "technical_plan" ? "plan"
        : task.kind === "acceptance_spec" ? "specification"
        : "output";
      const artifactTitle = task.kind === "technical_plan" ? "Technical Implementation Plan"
        : task.kind === "acceptance_spec" ? "Delivery Specification & Acceptance Criteria"
        : `${task.title} Output`;
      const artifact = addArtifact(role, artifactKind, artifactTitle, output);
      attachArtifactToTask(task.id, artifact.id);
      commitArtifactIds.push(artifact.id);
      appendTaskResult(task.id, `artifact:${artifact.id}`);
      emitEmployeeActivity(role, "context", `Beat ${beatId}: created artifact ${artifact.id} (${artifactTitle})`, {
        beatId, taskId, detail: { artifactId: artifact.id, artifactKind },
      });

      if (role === "pm" && task.kind === "acceptance_spec") {
        await writeArtifactToWorkspace(task.id, "pm", "pm-acceptance-spec", output);
      }
    }

    const updated = getSnapshot().tasks.find((t) => t.id === taskId);
    if (updated && updated.status !== "completed") {
      cpCommitTaskResult(snapshot.company.id, task.id, {
        summary: output?.slice(0, 300) || `${role} completed ${task.title} via beat ${beatId}`,
        artifacts: commitArtifactIds,
        filesModified,
        tokensUsed,
        beatId,
      });
    }

    if (role === "developer") {
      emitEmployeeActivity("system", "preview", `Beat ${beatId}: developer task done — checking auto-preview`, { beatId });
      tryAutoPreview().catch(() => {});
    }

    // ── Governance: trust lifecycle — success (Spec 13 Step 10) ──
    const completionEvent = buildTrustEvent(ctx.agentId, "task_completed", `Beat ${beatId}: ${task.title}`, new Date().toISOString());
    await cpUpdateTrustScore(completionEvent);
    if (beatViolationCount === 0) {
      const complianceEvent = buildTrustEvent(ctx.agentId, "manual_adjustment", `Beat ${beatId}: clean beat compliance bonus`, new Date().toISOString(), TRUST_CONFIG.complianceBonus);
      await cpUpdateTrustScore(complianceEvent);
    }
    emitEmployeeActivity(role, "decision", `Beat ${beatId}: trust lifecycle updated — task_completed${beatViolationCount === 0 ? " + compliance_bonus" : ""} (violations=${beatViolationCount})`, {
      beatId, taskId, detail: { beatViolationCount },
    });

    if (beatSprintId) {
      emitGraphBeatCompleted(beatSprintId, taskId, beatId, "completed", output?.slice(0, 300), 1, Date.now() - beatStartTime);
    }

    return {
      summary: output?.slice(0, 500) || `${role} worked on ${task.title}`,
      tokensUsed, actionsCount: 1, toolCalls: 1, completed: true,
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


