import { z } from "zod";
import type { AgentIdentity, Sprint, Task } from "@arceus/contracts";
import { createWorkflowTask, getAgentByRole, nowIso } from "@arceus/task-engine";
import { createSprintRecord } from "@arceus/task-engine";
import {
  getSnapshot,
  appendChatMessage,
  upsertTask,
  updateTask,
  updateSprint,
  upsertSprint,
  updateCompanySprint,
} from "../persistence/store.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphSprintStarted } from "../observability/graph-emitter.js";
import { emitReactiveBroadcast } from "../orchestration/reactive.js";
import { structuredCompletion } from "../infra/azure-openai.js";
import { buildCeoOperatingPrompt, classifyCeoResponse, type CeoCard } from "../agents/ceo.js";
import { orchestratorConfig } from "../config/index.js";
import { workspaceManager } from "../workspace/manager.js";
import { checkSprintCompletion } from "./lifecycle.js";
import {
  executionStatus,
  setExecutionStatus,
  ceoProposalInFlight,
  setCeoProposalInFlight,
  ceoProposalFailureCount,
  setCeoProposalFailureCount,
  ceoProposalCooldownUntilMs,
  setCeoProposalCooldownUntilMs,
  eventBridgeStarted,
  setEventBridgeStarted,
  activeExecution,
  setActiveExecution,
  CEO_PROPOSAL_FAILURES_BEFORE_COOLDOWN,
  CEO_PROPOSAL_COOLDOWN_MS,
} from "../orchestration/state.js";

export async function triggerCeoSprintProposal(): Promise<void> {
  if (ceoProposalInFlight) {
    emitEmployeeActivity(
      "ceo",
      "info",
      "CEO proposal already in flight — skipping duplicate trigger.",
    );
    return;
  }
  if (Date.now() < ceoProposalCooldownUntilMs) {
    const remainingSec = Math.ceil((ceoProposalCooldownUntilMs - Date.now()) / 1000);
    emitEmployeeActivity(
      "ceo",
      "info",
      `CEO proposal in cooldown after ${ceoProposalFailureCount} failures — retrying in ${remainingSec}s. Board can send a message to request a proposal manually.`,
    );
    return;
  }
  setCeoProposalInFlight(true);
  try {
    // Ensure the current sprint is marked complete before proposing a new one
    await checkSprintCompletion();

    const snapshot = getSnapshot();

    // Wait gate: don't propose a new sprint while the current one is still in-flight
    const inFlightSprint = snapshot.company.currentSprintId
      ? snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId)
      : null;
    if (inFlightSprint && inFlightSprint.status !== "completed") {
      emitEmployeeActivity(
        "ceo",
        "info",
        `CEO waiting — Sprint ${inFlightSprint.number} is "${inFlightSprint.status}". Next proposal will fire once it closes.`,
      );
      return;
    }

    // Duplicate guard: if a sprint_proposal card already exists for the current sprint,
    // try to auto-approve it instead of generating a new one.
    const existingProposal = snapshot.chatMessages.find(
      (m) => m.cardType === "sprint_proposal" && m.sprintId === snapshot.company.currentSprintId,
    );
    if (existingProposal) {
      const card = existingProposal.cardData as CeoCard | null;
      if (card?.sprint_proposal && orchestratorConfig.sprint.autoApproveProposals) {
        const nextSprintNumber = (snapshot.company.currentSprintNumber ?? 0) + 1;
        const cadence = orchestratorConfig.sprint.boardReviewEveryNSprints;
        const needsBoardReview = cadence > 0 && nextSprintNumber % cadence === 0;
        if (!needsBoardReview) {
          setExecutionStatus("done");
          emitEmployeeActivity("ceo", "info", `Re-approving existing Sprint ${nextSprintNumber} proposal.`);
          await approveSprintProposal(card);
        }
      }
      return;
    }

    // Set execution status so CEO stage infers as "between_sprints"
    setExecutionStatus("done");

    try {
      const ceoPrompt = buildCeoOperatingPrompt(snapshot, executionStatus);
      const ceoResponse = await structuredCompletion(
        "ceoDeployment",
        [
          { role: "system", content: ceoPrompt },
          { role: "user", content: "The previous sprint has completed. Analyze the results and propose the next sprint. Include sprint goal, key tasks with assigned roles and dependencies, carried-forward items, risks, and rationale." },
        ],
        z.object({ response: z.string() }),
        "ceo_sprint_proposal",
      );

      const ceoText = ceoResponse.response;
      const card = await classifyCeoResponse(ceoText, snapshot, executionStatus);

      appendChatMessage({
        id: `chat_${crypto.randomUUID()}`,
        companyId: snapshot.company.id,
        sprintId: snapshot.company.currentSprintId,
        agentId: getAgentByRole(snapshot, "ceo")?.id ?? null,
        role: "ceo",
        content: ceoText,
        cardType: card.card_type,
        cardData: card,
        createdAt: nowIso(),
      });

      const nextSprintNumber = (snapshot.company.currentSprintNumber ?? 0) + 1;
      const cadence = orchestratorConfig.sprint.boardReviewEveryNSprints;
      const needsBoardReview = cadence > 0 && nextSprintNumber % cadence === 0;

      if (orchestratorConfig.sprint.autoApproveProposals && !needsBoardReview && card.sprint_proposal) {
        emitEmployeeActivity(
          "ceo",
          "info",
          `CEO proposed Sprint ${nextSprintNumber}. Auto-approving (board review scheduled for Sprint ${Math.ceil(nextSprintNumber / cadence) * cadence}).`,
        );
        await approveSprintProposal(card);
      } else {
        const reason = needsBoardReview
          ? `CEO proposed Sprint ${nextSprintNumber}. Board review required (every ${cadence} sprints). Awaiting board approval.`
          : `CEO proposed Sprint ${nextSprintNumber}. Board can approve or provide feedback.`;
        emitEmployeeActivity("ceo", "info", reason);
      }
      setCeoProposalFailureCount(0);
      setCeoProposalCooldownUntilMs(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[Sprint] CEO sprint proposal generation failed:", message);
      const newCount = ceoProposalFailureCount + 1;
      setCeoProposalFailureCount(newCount);
      const hitCooldown = newCount >= CEO_PROPOSAL_FAILURES_BEFORE_COOLDOWN;
      if (hitCooldown) {
        setCeoProposalCooldownUntilMs(Date.now() + CEO_PROPOSAL_COOLDOWN_MS);
      }
      emitEmployeeActivity(
        "system",
        "error",
        hitCooldown
          ? `CEO sprint proposal failed ${newCount}x in a row (last: ${message}). Backing off for ${Math.round(CEO_PROPOSAL_COOLDOWN_MS / 60000)}m. Board can message the CEO directly to request a proposal.`
          : `Failed to auto-generate sprint proposal (attempt ${newCount}/${CEO_PROPOSAL_FAILURES_BEFORE_COOLDOWN}): ${message}. Board can message the CEO directly to request a proposal.`,
      );
    }
  } finally {
    setCeoProposalInFlight(false);
  }
}

export async function approveSprintProposal(card: CeoCard) {
  if (!card.sprint_proposal) {
    throw new Error("No sprint_proposal data in the provided card.");
  }

  if (executionStatus !== "done") {
    throw new Error(`Cannot approve sprint proposal while execution is "${executionStatus}". Must be "done".`);
  }

  const proposal = card.sprint_proposal;

  if (!proposal.key_tasks || proposal.key_tasks.length === 0) {
    throw new Error("Sprint proposal has no key_tasks. Ask CEO to repropose with tasks.");
  }

  const snapshot = getSnapshot();
  const currentSprint = snapshot.sprints.find((s) => s.id === snapshot.company.currentSprintId);
  if (currentSprint && currentSprint.status !== "completed") {
    throw new Error(`Current sprint (${currentSprint.number}) is still "${currentSprint.status}". Cannot start a new sprint.`);
  }

  // Create Sprint N+1
  const sprint = createSprintRecord(
    { upsertSprint, updateCompanySprint, emitReactiveBroadcast: emitReactiveBroadcast as (event: string) => void },
    snapshot,
    `Sprint ${(snapshot.company.currentSprintNumber ?? 0) + 1}: ${proposal.sprint_goal}`,
    proposal.sprint_goal,
  );
  let freshSnapshot = getSnapshot();

  // Create tasks from key_tasks
  const taskTitleToId = new Map<string, string>();
  const createdTasks: Task[] = [];

  for (const kt of proposal.key_tasks) {
    const role = kt.assigned_role as AgentIdentity["role"];
    const task = createWorkflowTask(
      freshSnapshot,
      "implementation",
      role,
      kt.title,
      kt.rationale || kt.title,
      kt.rationale || kt.title,
      kt.title,
      [`${kt.title} completed`],
      kt.priority as Task["priority"] || "medium",
      "created",
      sprint.id,
    );
    taskTitleToId.set(kt.title, task.id);
    createdTasks.push(task);
  }

  // Resolve explicit dependencies by title
  for (const kt of proposal.key_tasks) {
    const taskId = taskTitleToId.get(kt.title);
    if (!taskId) continue;
    const depIds = (kt.depends_on || [])
      .map((depTitle: string) => taskTitleToId.get(depTitle))
      .filter((id): id is string => Boolean(id));
    if (depIds.length > 0) {
      const idx = createdTasks.findIndex((t) => t.id === taskId);
      if (idx >= 0) {
        createdTasks[idx] = {
          ...createdTasks[idx],
          dependsOnTaskIds: depIds,
          parentTaskId: depIds[0],
        };
      }
    }
  }

  // Collect implementation task IDs (developer + ui_designer produce code artifacts)
  const implementationTaskIds = createdTasks
    .filter((t) => t.assignedRole === "developer" || t.assignedRole === "ui_designer")
    .map((t) => t.id);

  // Auto-add integration task: wire component work into the app entry file
  let integrationTaskId: string | null = null;
  if (implementationTaskIds.length >= 2) {
    const implementationTitles = createdTasks
      .filter((t) => implementationTaskIds.includes(t.id))
      .map((t) => `- ${t.title}`);
    const integrationDescription = [
      "Wire every component produced in this sprint into the application entry file (src/App.tsx or equivalent).",
      "",
      "Why: individual components must be imported and rendered by the app shell — existing on disk is not enough.",
      "",
      "Components produced in this sprint:",
      ...implementationTitles,
      "",
      "Steps:",
      "1. Open the entry file (src/App.tsx or whichever exists for this stack).",
      "2. Import each sprint component by its relative path.",
      "3. Render every imported component inside the app's JSX tree in a coherent layout.",
      "4. If routing is required, wire it here using the project's router.",
      "5. Pass realistic props — no placeholder-only renders.",
    ].join("\n");

    const integrationTask = createWorkflowTask(
      freshSnapshot,
      "implementation",
      "developer",
      "Wire sprint components into app entry (App.tsx)",
      integrationDescription,
      integrationDescription,
      "Every sprint component is imported and rendered by the entry file.",
      [
        "Entry file imports every component produced this sprint",
        "Entry file renders every component in a coherent layout",
        "App builds and the main view shows the integrated components",
      ],
      "critical",
      "created",
      sprint.id,
    );
    integrationTask.dependsOnTaskIds = [...implementationTaskIds];
    integrationTask.parentTaskId = implementationTaskIds[0];
    createdTasks.push(integrationTask);
    integrationTaskId = integrationTask.id;
  }

  // Implicit ordering: tester/QA tasks must wait for implementation AND integration
  const preTestDepIds = integrationTaskId
    ? [...implementationTaskIds, integrationTaskId]
    : implementationTaskIds;
  if (preTestDepIds.length > 0) {
    for (let i = 0; i < createdTasks.length; i++) {
      if (createdTasks[i].assignedRole !== "tester") continue;
      const existing = new Set(createdTasks[i].dependsOnTaskIds);
      const merged = [...createdTasks[i].dependsOnTaskIds];
      for (const depId of preTestDepIds) {
        if (!existing.has(depId)) merged.push(depId);
      }
      createdTasks[i] = {
        ...createdTasks[i],
        dependsOnTaskIds: merged,
        parentTaskId: createdTasks[i].parentTaskId || merged[0],
      };
    }
  }

  // Find leaf tasks (tasks that no other task depends on)
  const allDepIds = new Set(createdTasks.flatMap((t) => t.dependsOnTaskIds));
  const leafTaskIds = createdTasks
    .filter((t) => !allDepIds.has(t.id))
    .map((t) => t.id);

  // Auto-add CTO board_handoff review as final task
  const reviewTask = createWorkflowTask(
    freshSnapshot,
    "board_handoff",
    "cto",
    "CTO Sprint Review",
    "Review the sprint deliverables and prepare handoff summary.",
    "Verify all sprint work and produce review summary.",
    "Sprint review summary",
    ["All sprint deliverables reviewed", "Summary produced"],
    "medium",
    "created",
    sprint.id,
  );
  reviewTask.dependsOnTaskIds = leafTaskIds;
  reviewTask.parentTaskId = leafTaskIds[0] || null;
  createdTasks.push(reviewTask);

  // Add child links for leaf → review
  for (const leafId of leafTaskIds) {
    const idx = createdTasks.findIndex((t) => t.id === leafId);
    if (idx >= 0) {
      createdTasks[idx] = {
        ...createdTasks[idx],
        childTaskIds: [...createdTasks[idx].childTaskIds, reviewTask.id],
      };
    }
  }

  // Persist all tasks
  for (const task of createdTasks) {
    upsertTask(task);
  }

  // ── Graph instrumentation (Spec 22) — Sprint N+1 graph ──
  emitGraphSprintStarted(sprint.id, sprint.number, sprint.goal, createdTasks, "ceo_proposal");

  // Auto-promote tasks with no dependencies to "planned"
  for (const task of createdTasks) {
    if (task.dependsOnTaskIds.length === 0 && task.status === "created") {
      updateTask(task.id, (t) => ({ ...t, status: "planned" as Task["status"] }));
    }
  }

  // Mark sprint as active
  updateSprint(sprint.id, (s) => ({
    ...s,
    status: "executing" as Sprint["status"],
    startedAt: nowIso(),
  }));

  emitEmployeeActivity(
    "system",
    "info",
    `Sprint ${sprint.number} approved with ${createdTasks.length} tasks. Starting execution.`,
  );

  setActiveExecution({
    companyId: freshSnapshot.company.id,
    buildTaskId: "",
    previewTaskId: "",
    reviewTaskId: reviewTask.id,
  });

  await beginSprintExecution();

  return { sprintId: sprint.id, sprintNumber: sprint.number, taskCount: createdTasks.length };
}

/**
 * Rejects a sprint proposal — resets to "done" so the board can re-chat with CEO.
 */
export function rejectSprintProposal() {
  setExecutionStatus("done");
  emitEmployeeActivity(
    "system",
    "info",
    "Sprint proposal rejected by board. CEO awaits further direction via chat.",
  );
  return { executionStatus };
}

/**
 * Lighter execution entry for Sprint 2+ — uses tasks already created by approveSprintProposal.
 * Accepts an optional `onStartEventBridge` callback to start the event bridge without
 * creating a circular dependency with the heartbeat module.
 */
export async function beginSprintExecution(
  onStartEventBridge?: () => Promise<void>,
): Promise<void> {
  const snapshot = getSnapshot();

  setExecutionStatus("executing");

  try {
    await workspaceManager.ensureLocal(snapshot.company.id);

    if (!eventBridgeStarted && onStartEventBridge) {
      onStartEventBridge().catch(() => {});
      setEventBridgeStarted(true);
    }

    emitEmployeeActivity(
      "system",
      "info",
      "Sprint execution ready — heartbeat engine will pick up planned tasks.",
    );
  } catch (err) {
    setExecutionStatus("error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    emitEmployeeActivity("system", "error", `Sprint execution failed: ${msg}`);
  }
}
