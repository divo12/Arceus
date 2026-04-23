import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentIdentity, CompanySnapshot, Task } from "@arceus/contracts";
import { getAgentByRole, uniqueStrings } from "@arceus/task-engine";
import { getSnapshot, updateTask } from "../persistence/store.js";
import { audit } from "../observability/audit-ledger.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import {
  emitGraphStatusChanged,
  emitGraphArtifactProduced,
  emitGraphArtifactConsumed,
  emitGraphFileChanges,
  emitGraphMemoryWrite,
  resolveActiveSprintId,
} from "../observability/graph-emitter.js";
import { persistRuntimeArtifact } from "../persistence/artifact-persistence.js";
import { describePgError } from "../infra/pg-errors.js";
import { workspaceManager } from "../workspace/manager.js";
import {
  processTaskOutcome,
  runATAPipeline,
  extractPattern,
  matchSkills as registryMatchSkills,
} from "@arceus/company-runtime";
import { applyGovernanceToMutation } from "../skills/governance.js";
import { emitReactive } from "../orchestration/reactive.js";
import { triggerEscalationMeeting } from "../orchestration/reactive.js";
import { artifacts, productDir, type Artifact } from "../orchestration/state.js";
import { hippocampus } from "../memory/extractors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Artifact helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a runtime artifact, persist it, and append to the in-memory list. */
export function addArtifact(agent: string, kind: Artifact["kind"], title: string, content: string) {
  const artifact: Artifact = {
    id: `artifact_${crypto.randomUUID()}`,
    agent,
    kind,
    title,
    content,
    createdAt: new Date().toISOString(),
  };
  artifacts.push(artifact);
  void persistRuntimeArtifact(getSnapshot().company.id, artifact);
  // Auto-write artifact to workspace filesystem
  void writeArtifactToDisk(artifact).catch(() => {});
  return artifact;
}

/** Slugify a title for use as a filename. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled";
}

/** Write an artifact to the appropriate workspace folder based on its kind. */
async function writeArtifactToDisk(artifact: Artifact): Promise<void> {
  const subdir = artifact.kind === "specification" ? "specs" : "artifacts";
  const dir = join(productDir, subdir);
  await mkdir(dir, { recursive: true });
  const slug = slugify(artifact.title);
  const filePath = join(dir, `${slug}.md`);
  const header = `<!-- artifact: ${artifact.id} | agent: ${artifact.agent} | kind: ${artifact.kind} -->\n# ${artifact.title}\n\n`;
  await writeFile(filePath, `${header}${artifact.content}\n`, "utf8");
  emitEmployeeActivity(artifact.agent, "file_edit", `Artifact written to ${subdir}/${slug}.md`, {
    detail: { artifactId: artifact.id, path: `${subdir}/${slug}.md` },
  });
}

/** Write an artifact's content as a markdown file into the product docs directory. */
export async function writeArtifactToWorkspace(
  taskId: string,
  role: string,
  slug: string,
  content: string,
): Promise<void> {
  const docsDir = join(productDir, "docs");
  await mkdir(docsDir, { recursive: true });
  const filePath = join(docsDir, `${slug}.md`);
  await writeFile(filePath, `${content}\n`, "utf8");

  const relativePath = `docs/${slug}.md`;
  const sid = resolveActiveSprintId();
  if (sid) {
    emitGraphFileChanges(sid, taskId, [{ path: relativePath, action: "created", linesChanged: content.split("\n").length }]);
  }
}

/** Commit and push the product workspace via git; logs warnings on failure. */
export async function syncWorkspaceCheckpoint(taskId: string, agentRole: string, message: string) {
  const companyId = getSnapshot().company.id;
  if (!companyId || companyId === "company_pending") {
    return;
  }

  try {
    const result = await workspaceManager.commitAndSync(companyId, taskId, agentRole, message);
    if (result.warnings.length > 0) {
      emitEmployeeActivity("system", "info", `Workspace sync completed with warnings: ${result.warnings.join(" | ")}`, {
        taskId,
      });
      return;
    }

    emitEmployeeActivity("system", "info", `Workspace sync complete at commit ${result.commitSha}.`, {
      taskId,
    });
  } catch (error) {
    emitEmployeeActivity("system", "error", error instanceof Error ? error.message : "Workspace sync failed.", {
      taskId,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task field mutations
// ─────────────────────────────────────────────────────────────────────────────

/** Build a text summary of a task's state, results, and artifacts for memory storage. */
export function buildTaskMemoryOutput(task: Task, feedback?: string | null): string {
  const sections: string[] = [
    `Task: ${task.title}`,
    `Role: ${task.assignedRole}`,
    `Kind: ${task.kind}`,
    `Status: ${task.status}`,
  ];

  if (feedback) {
    sections.push(`Outcome: ${feedback}`);
  }

  const editedFiles = task.executorState.results
    .filter((r) => r.startsWith("edited:"))
    .map((r) => r.replace("edited:", ""));
  if (editedFiles.length > 0) {
    sections.push(`Files edited: ${editedFiles.join(", ")}`);
  }

  const previews = task.executorState.results
    .filter((r) => r.startsWith("preview:"))
    .map((r) => r.replace("preview:", ""));
  if (previews.length > 0) {
    sections.push(`Preview: ${previews.join(", ")}`);
  }

  let artifactBudget = 4000;
  for (const artifactId of task.artifactIds) {
    if (artifactBudget <= 0) break;
    const artifact = artifacts.find((a) => a.id === artifactId);
    if (!artifact) continue;
    const snippet = artifact.content.slice(0, artifactBudget);
    sections.push(`\n--- Artifact: ${artifact.title} ---\n${snippet}`);
    artifactBudget -= snippet.length;
  }

  return sections.join("\n");
}

/** Append a result string to a task's executor results (capped at 50). */
export function appendTaskResult(taskId: string, result: string) {
  updateTask(taskId, (task) => ({
    ...task,
    executorState: {
      ...task.executorState,
      results: [...task.executorState.results, result].slice(-50),
    },
  }));
}

/** Link an artifact to a task and emit a graph event for the sprint. */
export function attachArtifactToTask(taskId: string, artifactId: string) {
  updateTask(taskId, (task) => ({
    ...task,
    artifactIds: task.artifactIds.includes(artifactId) ? task.artifactIds : [...task.artifactIds, artifactId],
  }));

  const task = getSnapshot().tasks.find((t) => t.id === taskId);
  const sprintId = task?.sprintId ?? resolveActiveSprintId();
  if (sprintId) {
    const artifact = artifacts.find((a) => a.id === artifactId);
    emitGraphArtifactProduced(sprintId, taskId, artifactId, artifact?.kind ?? "output", artifact?.title ?? artifactId);
  }
}

/** Update the task's local preview URL. */
export function setTaskPreviewUrl(taskId: string, localPreviewUrl: string | null) {
  updateTask(taskId, (task) => ({
    ...task,
    localPreviewUrl,
  }));
}

/** Populate a task's title, description, DoD, and priority from a planner spec. */
export function hydrateTaskFromSpec(taskId: string, spec: {
  title: string;
  description: string;
  problem_statement: string;
  deliverable: string;
  definition_of_done: string[];
  priority: Task["priority"];
}) {
  updateTask(taskId, (task) => ({
    ...task,
    title: spec.title,
    description: spec.description,
    problemStatement: spec.problem_statement,
    deliverable: spec.deliverable,
    definitionOfDone: spec.definition_of_done,
    priority: spec.priority,
    plannerState: {
      ...task.plannerState,
      objective: spec.problem_statement,
    },
  }));
}

/** Append a plan step to the task's planner state (deduped, capped at 12). */
export function appendTaskPlanStep(taskId: string, step: string) {
  updateTask(taskId, (task) => ({
    ...task,
    plannerState: {
      ...task.plannerState,
      planSteps: uniqueStrings([...task.plannerState.planSteps, step], 12),
    },
  }));
}

/** Record a command execution on the task's executor state (capped at 50). */
export function appendTaskCommand(taskId: string, command: string) {
  updateTask(taskId, (task) => ({
    ...task,
    executorState: {
      ...task.executorState,
      currentCommand: command,
      commandsExecuted: [...task.executorState.commandsExecuted, command].slice(-50),
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// setTaskStatus — the big one: transitions, graph, audit, downstream promote,
// hippocampus memory, skill outcome tracking, pattern extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transition a task's status with full side-effects: graph instrumentation,
 * audit logging, escalation on block, downstream dependency promotion,
 * hippocampus memory, and skill outcome tracking.
 */
export function setTaskStatus(taskId: string, status: Task["status"], feedback?: string | null) {
  const prev = getSnapshot().tasks.find((t) => t.id === taskId);
  const prevStatus = prev?.status ?? "unknown";
  updateTask(taskId, (task) => ({
    ...task,
    status,
    verifierState: {
      ...task.verifierState,
      feedback: feedback ?? task.verifierState.feedback,
    },
  }));

  // ── Graph instrumentation (Spec 22) ──
  const sprintId = prev?.sprintId ?? resolveActiveSprintId();
  if (sprintId) {
    emitGraphStatusChanged(sprintId, taskId, prevStatus, status, prev?.assignedRole ?? "system", feedback ?? `${prevStatus} → ${status}`);
  }

  // Audit task transitions
  audit({
    companyId: prev?.companyId ?? getSnapshot().company.id,
    category: "task_lifecycle",
    severity: status === "failed" ? "warn" : "info",
    eventType: `task_${status}`,
    agentRole: prev?.assignedRole ?? null,
    summary: `Task "${prev?.title ?? taskId}" ${prevStatus} → ${status}`,
    detail: { taskId, previousStatus: prevStatus, feedback: feedback ?? null },
    correlationId: taskId,
  });

  // Phase 7: Trigger escalation meeting when a task becomes blocked
  if (status === "blocked" && prevStatus !== "blocked") {
    triggerEscalationMeeting(taskId, feedback ?? `Task "${prev?.title ?? taskId}" is blocked`);
  }

  // Auto-promote downstream tasks when a task completes
  if (status === "completed") {
    const snapshot = getSnapshot();
    const completedTask = snapshot.tasks.find((t) => t.id === taskId);

    // Propagate artifacts from the completed task to its direct children
    if (completedTask && completedTask.artifactIds.length > 0) {
      for (const childId of completedTask.childTaskIds) {
        updateTask(childId, (t) => ({
          ...t,
          incomingArtifactIds: uniqueStrings([...t.incomingArtifactIds, ...completedTask.artifactIds], 20),
        }));
        const sid = completedTask.sprintId ?? resolveActiveSprintId();
        if (sid) {
          emitGraphArtifactConsumed(sid, childId, taskId, completedTask.artifactIds, null);
        }
      }
    }

    for (const task of snapshot.tasks) {
      if (task.status !== "created") continue;
      if (task.kind === "follow_up") continue;
      if (task.dependsOnTaskIds.length === 0) continue;
      const allDepsMet = task.dependsOnTaskIds.every((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return dep?.status === "completed";
      });
      if (allDepsMet) {
        const upstreamArtifactIds: string[] = [];
        for (const depId of task.dependsOnTaskIds) {
          const dep = snapshot.tasks.find((t) => t.id === depId);
          if (dep) {
            upstreamArtifactIds.push(...dep.artifactIds);
            if (dep.artifactIds.length > 0) {
              const sid = dep.sprintId ?? resolveActiveSprintId();
              if (sid) {
                emitGraphArtifactConsumed(sid, task.id, depId, dep.artifactIds, null);
              }
            }
          }
        }
        updateTask(task.id, (t) => ({
          ...t,
          status: "planned" as Task["status"],
          incomingArtifactIds: uniqueStrings([...t.incomingArtifactIds, ...upstreamArtifactIds], 20),
        }));
        if (task.assignedRole) {
          emitReactive(task.assignedRole, "task_dependency_met");
        }
      }
    }
  }

  // Hippocampus: store memory + update priming on terminal status
  if (["completed", "failed", "cancelled"].includes(status)) {
    const snapshot = getSnapshot();
    const task = snapshot.tasks.find((t) => t.id === taskId);
    if (task) {
      const agent = getAgentByRole(snapshot, task.assignedRole);
      if (agent) {
        const outcome = status === "completed" ? "success" : status === "failed" ? "failure" : "partial";
        const memoryOutput = buildTaskMemoryOutput(task, feedback);

        const sid = resolveActiveSprintId();
        if (sid) {
          emitGraphMemoryWrite(
            sid,
            task.id,
            task.assignedRole,
            task.id,
            null,
            "dynamic",
            "task_completion",
            `Memory stored for "${task.title}" (${outcome})`,
            memoryOutput.slice(0, 500),
            outcome,
            true,
          );
        }

        hippocampus.processTaskCompletion({
          agentId: agent.id,
          taskId: task.id,
          companyId: snapshot.company.id,
          output: memoryOutput,
          outcome,
          taskTitle: task.title,
          role: task.assignedRole,
        }).catch((err) => {
          console.warn(`[Hippocampus] processTaskCompletion failed for ${task.id}: ${describePgError(err)}`);
        });
      }

      // Spec 14 Phase 2: update success rates + trigger failure attribution
      if (status === "completed" || status === "failed") {
        processTaskOutcome({
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          assignedRole: task.assignedRole,
          companyId: snapshot.company.id,
          status,
          iterationCount: task.iterationCount,
          executionTrace: feedback ?? undefined,
        }).then(async (mutation) => {
          if (mutation) {
            console.log(`[SkillMutator] Proposed ${mutation.originalSkillId ? "mutation" : "discovery"}: ${mutation.id} (${mutation.reason})`);

            const gov = await applyGovernanceToMutation({
              mutation,
              companyId: snapshot.company.id,
              sprintId: task.sprintId ?? snapshot.company.currentSprintId ?? null,
              proposerAgentId: null,
              proposerRole: "system",
              estimatedCostCents: mutation.originalSkillId ? 1 : 2,
            });
            if (!gov.allowed) {
              console.warn(`[Governance] Mutation ${mutation.id} refused — ${gov.code}: ${gov.reason}`);
              return;
            }

            runATAPipeline(mutation.id).then((result) => {
              console.log(`[ATA] ${result.verdict.toUpperCase()} for ${mutation.id} (score=${result.reviewVerdict.overallScore}, revisions=${result.revisionCycles})`);
            }).catch((err) => {
              console.warn(`[ATA] Pipeline error for ${mutation.id}: ${err instanceof Error ? err.message : err}`);
            });
          }
        }).catch((err) => {
          console.warn(`[SkillMutator] processTaskOutcome error for ${task.id}: ${err instanceof Error ? err.message : err}`);
        });
      }

      // Spec 14 Phase 5: record task trajectory as a Pattern
      if (status === "completed" || status === "failed") {
        const patternOutcome = status === "failed"
          ? "failure" as const
          : task.iterationCount > 1
            ? "high_friction" as const
            : "success" as const;
        const activeSkillIds = registryMatchSkills(
          snapshot.company.id,
          task.assignedRole,
          `${task.title} ${task.description}`,
        ).map((s) => s.id);
        extractPattern({
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          assignedRole: task.assignedRole,
          companyId: snapshot.company.id,
          outcome: patternOutcome,
          trajectory: feedback ?? undefined,
          activeSkillIds,
          sprintId: task.sprintId ?? snapshot.company.currentSprintId ?? null,
        }).then((pattern) => {
          if (pattern.usageCount === 1) {
            console.log(`[PatternLearner] New pattern ${pattern.id} for "${task.title.slice(0, 40)}"`);
          }
        }).catch((err) => {
          console.warn(`[PatternLearner] extractPattern error for ${task.id}: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  }
}
