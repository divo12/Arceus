import type { AgentIdentity, Approval, CompanySnapshot, Task } from "@arceus/contracts";
import { getAgentByRole, taskSortWeight, specialistRoleWeight } from "@arceus/task-engine";
import { getRoleSoul, getAgentSkills } from "@arceus/company-runtime";
import { z } from "zod";
import { getSnapshot, updateMeeting } from "../persistence/store.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphDecision } from "../observability/graph-emitter.js";
import { probePreviewHealth, getLocalPreviewState } from "../workspace/preview.js";
import { checkEntryPointImports } from "../workspace/entry-check.js";
import { structuredCompletion } from "../infra/azure-openai.js";
import { orchestratorConfig } from "../config/index.js";
import { CORE_EXECUTION_TASK_KINDS, productDir } from "../orchestration/state.js";
import { updateRoleMemory } from "../memory/operations.js";
import {
  deliverUiDesignerMemoryHandoff,
  deliverSkillsLeadMemoryHandoff,
  createMarketingExternalApproval,
  getSpecialistMeetingContext,
} from "../memory/handoffs.js";
import { recordMeeting } from "../meetings/recording.js";
import { touchAgentSession } from "../agents/sessions.js";
import { ensureAgentSession, runPromptText } from "../prompts/llm.js";
import { buildSpecialistTaskPrompt } from "../prompts/specialist.js";
import { getPreviewEvidenceUrl, buildTesterArtifact, buildDesignDirectionArtifact, buildMarketingArtifact } from "../prompts/artifacts.js";
import { buildSkillAuthoringArtifact, materializeSkillPackage } from "../skills/packaging.js";
import { setTaskVerified, isTaskReadyForAutonomousExecution } from "./helpers.js";
import {
  addArtifact,
  writeArtifactToWorkspace,
  syncWorkspaceCheckpoint,
  appendTaskResult,
  attachArtifactToTask,
  setTaskPreviewUrl,
  setTaskStatus,
} from "./mutations.js";

/**
 * Execute a single specialist task end-to-end: check deps, run the role's LLM
 * session, produce artifacts, record meetings, and transition task status.
 */
export async function executeSpecialistTask(taskId: string) {
  const snapshot = getSnapshot();
  const task = snapshot.tasks.find((entry) => entry.id === taskId);
  if (!task) return;

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
      emitEmployeeActivity(task.assignedRole, "decision", `Specialist task "${task.title}" skipped — ${unmetDeps.length} unmet dependency(ies): ${depDetails.join(", ")}`);
      return;
    }
  }

  const assignedAgent = getAgentByRole(snapshot, task.assignedRole);
  if (!assignedAgent) {
    setTaskStatus(task.id, "blocked", `No active ${task.assignedRole} agent is available for this task.`);
    recordMeeting({
      type: "escalation",
      facilitatorRole: "cto",
      participantRoles: ["cto", "ceo"],
      summary: `Autonomous specialist task blocked because role ${task.assignedRole} is not staffed.`,
      agenda: [{
        topic: "Missing specialist coverage",
        type: "blocker",
        content: `Task ${task.title} cannot start because no ${task.assignedRole} agent is available.`,
        raisedByRole: "cto",
        relatedTaskId: task.id,
      }],
      decisions: [{
        description: `Leadership must either hire or re-plan work assigned to ${task.assignedRole}.`,
        decidedByRoles: ["cto", "ceo"],
        impactIds: [task.id],
      }],
      taskModifications: [{
        taskId: task.id,
        modificationType: "unblock",
        details: `Blocked because role ${task.assignedRole} is not staffed.`,
        resultingStatus: "blocked",
      }],
    });
    return;
  }

  const role = task.assignedRole;
  const roleSession = await ensureAgentSession(snapshot, role);
  const soul = getRoleSoul(role);
  const previewEvidenceUrl = getPreviewEvidenceUrl();

  if (role === "tester" && ["qa_verification", "service_validation"].includes(task.kind)) {
    const preview = getLocalPreviewState();
    if (preview.status !== "ready" || !previewEvidenceUrl) {
      setTaskStatus(task.id, "blocked", "Tester verification requires a ready preview or validation endpoint.");
      recordMeeting({
        type: "escalation",
        facilitatorRole: "tester",
        participantRoles: ["tester", "developer", "cto"],
        summary: `Tester could not start ${task.title} because preview evidence is not ready.`,
        agenda: [{
          topic: "Verification blocked",
          type: "blocker",
          content: "Tester verification requires a reachable preview or validation URL before QA can proceed.",
          raisedByRole: "tester",
          relatedTaskId: task.id,
        }],
        decisions: [{
          description: "Developer and CTO must restore preview readiness before tester verification resumes.",
          decidedByRoles: ["tester", "developer", "cto"],
          impactIds: [task.id],
        }],
      });
      return;
    }
  }

  touchAgentSession(role, "working");
  setTaskStatus(task.id, "in_progress");
  updateRoleMemory(role, [task.title, `Workspace: ${productDir}`]);
  emitEmployeeActivity(role, "working", `Autonomously executing specialist task: ${task.title}`, { taskId: task.id });

  const output = await runPromptText(role, roleSession.sessionId, soul.systemPrompt + getAgentSkills(role), buildSpecialistTaskPrompt(task));

  touchAgentSession(role, "idle");
  const artifactTitle = role === "tester"
    ? task.kind === "service_validation" ? "Service Validation Report" : "QA Verification Report"
    : role === "ui_designer" ? "Design Direction Report"
    : role === "marketing" ? "Launch Readiness Report"
    : role === "skills_lead" ? "Skill Package Report"
    : `${task.title} Output`;
  const artifactContent = role === "tester"
    ? buildTesterArtifact(task, output)
    : role === "ui_designer" ? buildDesignDirectionArtifact(task, output)
    : role === "marketing" ? buildMarketingArtifact(task, output)
    : role === "skills_lead" ? buildSkillAuthoringArtifact(task, output)
    : (output || `${role} completed ${task.title}.`);
  const artifact = addArtifact(role, "output", artifactTitle, artifactContent);
  appendTaskResult(task.id, `artifact:${artifact.id}`);
  if (role === "tester") {
    appendTaskResult(task.id, `verification:${getPreviewEvidenceUrl() ?? "no-preview-url"}`);
  }
  attachArtifactToTask(task.id, artifact.id);
  const artifactSlug = role === "tester" ? "tester-report"
    : role === "ui_designer" ? "ui-design-direction"
    : role === "marketing" ? "marketing-report"
    : null;
  if (artifactSlug) {
    await writeArtifactToWorkspace(task.id, role, artifactSlug, artifactContent);
  }
  if (role === "tester") {
    const evidenceUrl = getPreviewEvidenceUrl();
    setTaskPreviewUrl(task.id, evidenceUrl);
    setTaskStatus(task.id, "completed", evidenceUrl ? `Tester verified the current target via ${evidenceUrl}.` : "Tester completed the verification task.");
  } else if (role === "ui_designer") {
    deliverUiDesignerMemoryHandoff(task, artifact.id);
    setTaskStatus(task.id, "completed", "UI Designer delivered concrete design direction to Developer and Tester.");
  } else if (role === "marketing") {
    setTaskStatus(
      task.id,
      "completed",
      task.kind === "distribution_campaign"
        ? "Marketing prepared launch-readiness recommendations and requested board approval before any external action."
        : "Marketing prepared launch-readiness reporting for internal release planning.",
    );
  } else if (role === "skills_lead") {
    const skillPackage = await materializeSkillPackage(task, output || artifactContent);
    appendTaskResult(task.id, `skill-package:${skillPackage.relativePath}`);
    deliverSkillsLeadMemoryHandoff(task, artifact.id, skillPackage.relativePath);
    setTaskStatus(task.id, "completed", `Skills Lead authored reusable package ${skillPackage.relativePath}.`);
    await syncWorkspaceCheckpoint(task.id, role, `Skills Lead authored reusable package ${skillPackage.relativePath}`);
  } else if (role === "cto" && task.kind === "board_handoff") {
    const reviewProbe = await probePreviewHealth(8000);
    if (!reviewProbe.reachable) {
      setTaskStatus(task.id, "blocked", `CTO review blocked — preview unreachable: ${reviewProbe.error ?? "no response"}. Developer must fix the preview before sprint review can proceed.`);
      emitEmployeeActivity("cto", "error", `Board handoff blocked — preview not reachable (${reviewProbe.error}). Cannot approve sprint without a working product.`, { taskId: task.id });
      recordMeeting({
        type: "escalation",
        facilitatorRole: "cto",
        participantRoles: ["cto", "developer"],
        summary: `CTO board handoff blocked: preview is unreachable (${reviewProbe.error}). Developer must fix the preview.`,
        agenda: [{
          topic: "Preview unreachable",
          type: "blocker" as const,
          content: `The product preview is not reachable. Error: ${reviewProbe.error ?? "unknown"}. The CTO cannot approve a sprint without a working, accessible product.`,
          raisedByRole: "cto" as const,
          relatedTaskId: task.id,
        }],
        decisions: [{
          description: "Developer must restore preview before CTO review can complete.",
          decidedByRoles: ["cto"],
          impactIds: [task.id],
        }],
      });
      return;
    }
    const ctoEntryCheck = checkEntryPointImports();
    if (!ctoEntryCheck.pass) {
      setTaskStatus(task.id, "blocked", `CTO review blocked — ${ctoEntryCheck.reason}`);
      emitEmployeeActivity("cto", "error", `Board handoff blocked — entry-point disconnected: ${ctoEntryCheck.reason}`, { taskId: task.id });
      return;
    }
    setTaskStatus(task.id, "completed", `CTO review completed — preview verified reachable (HTTP ${reviewProbe.statusCode}), entry-point imports verified${reviewProbe.hasProductContent ? ", product content detected" : ""}.`);
    setTaskVerified(task.id, "cto_board_handoff");
  } else {
    setTaskStatus(task.id, "completed", `${role} completed the specialist task.`);
  }

  const specialistMeetingContext = getSpecialistMeetingContext(role, task, artifact.id);
  const completionMeeting = recordMeeting({
    type: "eval_triggered",
    facilitatorRole: role,
    participantRoles: specialistMeetingContext.participantRoles,
    summary: `${role.replace(/_/g, " ")} completed specialist task ${task.title}.`,
    agenda: [{
      topic: "Specialist task output",
      type: "update",
      content: `${role.replace(/_/g, " ")} completed ${task.title} and attached an artifact for downstream review.`,
      raisedByRole: role,
      relatedTaskId: task.id,
    }],
    decisions: [{
      description: `${specialistMeetingContext.managerRole.toUpperCase()} can use the specialist output in the ongoing execution cycle.`,
      decidedByRoles: [role, specialistMeetingContext.managerRole],
      impactIds: [task.id, artifact.id],
    }],
    learnings: specialistMeetingContext.learnings,
  });

  let approval: Approval | null = null;
  if (role === "marketing" && task.kind === "distribution_campaign") {
    approval = createMarketingExternalApproval(task, artifact.id, completionMeeting.id);
    if (approval) {
      const createdApproval = approval;
      appendTaskResult(task.id, `approval:${approval.id}`);
      updateMeeting(completionMeeting.id, (meeting) => ({
        ...meeting,
        resolutions: {
          decisions: [
            ...(meeting.resolutions?.decisions ?? []),
            {
              conflictId: null,
              blockerId: null,
              decision: `Board approval required for marketing external distribution. Approval ID: ${createdApproval.id}`,
              action: "escalate_to_board" as const,
              escalation: {
                question: "Approve external marketing distribution?",
                context: `Task: ${task.title}`,
                severity: "medium" as const,
              },
            },
          ],
        },
      }));
    }
  }

  emitEmployeeActivity(role, "idle", approval
    ? `${task.title} complete → /api/artifacts/${artifact.id} and board approval ${approval.id}`
    : `${task.title} complete → /api/artifacts/${artifact.id}`, {
    taskId: task.id,
    meetingId: completionMeeting.id,
  });
}

// ---------------------------------------------------------------------------
// Specialist task pruning
// ---------------------------------------------------------------------------

const SpecialistPruneVerdict = z.object({
  resolved: z.array(z.object({
    taskId: z.string(),
    reason: z.string(),
  })),
});

/**
 * Use an LLM workspace audit to auto-resolve queued specialist tasks
 * whose definition-of-done is already satisfied by the developer implementation.
 */
export async function pruneAlreadyCompletedSpecialistTasks(snapshot: CompanySnapshot): Promise<number> {
  const pendingSpecialist = snapshot.tasks.filter(
    (task) =>
      !CORE_EXECUTION_TASK_KINDS.has(task.kind) &&
      ["created", "planned"].includes(task.status),
  );
  if (pendingSpecialist.length === 0) return 0;

  const taskSummary = pendingSpecialist.map((t) =>
    `- id="${t.id}" kind=${t.kind} role=${t.assignedRole} title="${t.title}" dod=[${t.definitionOfDone.join("; ")}]`
  ).join("\n");

  const prompt = [
    "You decide which queued specialist tasks have ALREADY been satisfied by the developer implementation.",
    "USE YOUR TOOLS to read the source files in the product workspace:",
    `- Product directory: ${productDir}`,
    `- Start with the entry file (e.g. ${productDir}/src/App.tsx or ${productDir}/src/main.tsx)`,
    "- Read imports and follow them to verify each task's definition-of-done",
    "",
    "A task is resolved ONLY if:",
    "- The source code clearly implements the definition-of-done",
    "- The implemented code is actually IMPORTED and USED (not just existing as an orphaned file)",
    "- For UI tasks: components are rendered in the app entry point, not just defined",
    "- For integration tasks: modules are connected, not just co-located",
    "Do not resolve tasks that require runtime verification (e.g. running tests, checking HTTP).",
    "When in doubt, do NOT resolve — let the specialist agent verify.",
    "",
    "After reading the files, list which task IDs are already resolved, with a short reason for each.",
    "",
    "Pending specialist tasks:",
    taskSummary,
  ].join("\n");

  try {
    const session = await ensureAgentSession(snapshot, "tester");
    const soul = getRoleSoul("tester");
    const output = await runPromptText("tester", session.sessionId, soul.systemPrompt + getAgentSkills("tester"), prompt);

    if (!output) return 0;

    const verdict = await structuredCompletion(
      "workerDeployment",
      [
        {
          role: "system",
          content: "Extract the list of resolved task IDs and reasons from the tester's analysis below. Only include tasks the tester explicitly confirmed as already implemented.",
        },
        { role: "user", content: output },
      ],
      SpecialistPruneVerdict,
      "specialist_prune_verdict_extract",
      { temperature: 0 },
    );

    const validIds = new Set(pendingSpecialist.map((t) => t.id));
    let resolved = 0;
    for (const item of verdict.resolved) {
      if (!validIds.has(item.taskId)) continue;
      setTaskStatus(item.taskId, "completed", `Auto-resolved by workspace audit: ${item.reason}`);
      resolved += 1;

      const pruneSprintId = snapshot.company.currentSprintId;
      if (pruneSprintId) {
        emitGraphDecision(pruneSprintId, item.taskId, "prune_decision",
          `Pruned: ${item.taskId}`, item.reason, "tester");
      }
    }
    return resolved;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Autonomous ready task runner
// ---------------------------------------------------------------------------

/** Run all autonomously-ready specialist tasks in priority order, repeating until none remain. */
export async function runAutonomousReadyTasks(checkpoint: string) {
  let pass = 0;

  while (pass < orchestratorConfig.execution.autonomousReadyPassLimit) {
    const snapshot = getSnapshot();
    const readyTasks = snapshot.tasks
      .filter((task) => isTaskReadyForAutonomousExecution(task, snapshot))
      .sort((left, right) => {
        const roleDelta = specialistRoleWeight(left.assignedRole, orchestratorConfig.specialistRoleWeights) - specialistRoleWeight(right.assignedRole, orchestratorConfig.specialistRoleWeights);
        if (roleDelta !== 0) {
          return roleDelta;
        }
        return taskSortWeight(left) - taskSortWeight(right);
      });

    if (readyTasks.length === 0) {
      if (pass === 0) {
        emitEmployeeActivity("system", "info", `No specialist tasks were ready at ${checkpoint}.`);
      }
      return;
    }

    for (const task of readyTasks) {
      await executeSpecialistTask(task.id);
    }

    pass += 1;
  }

  emitEmployeeActivity("system", "info", `Specialist scheduler stopped after hitting the pass limit at ${checkpoint}.`);
}
