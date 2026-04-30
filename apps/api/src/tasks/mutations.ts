import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentIdentity, CompanySnapshot, Task } from "@arceus/contracts";
import { getAgentByRole, uniqueStrings, MAX_INCOMING_ARTIFACT_IDS } from "@arceus/task-engine";
import { updateTask, writeArtifactSync } from "../persistence/mutations.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
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
import { describePgError } from "../infra/pg-errors.js";
import { workspaceManager } from "../workspace/manager.js";
import { swallowAndAudit } from "../observability/swallow.js";
import {
  processTaskOutcome,
  runATAPipeline,
  extractPattern,
  matchSkills as registryMatchSkills,
} from "@arceus/company-runtime";
import { applyGovernanceToMutation } from "../skills/governance.js";
import { emitReactive } from "../orchestration/reactive.js";
import { triggerEscalationMeeting } from "../orchestration/reactive.js";
import { productDir, type Artifact } from "../orchestration/state.js";
import { getDb } from "@arceus/db";
import * as artifactsRepo from "@arceus/db/src/repos/artifacts.js";
import { hippocampus } from "../memory/extractors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Artifact helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a runtime artifact, persist it durably, then write it to disk.
 * Awaits the DB insert before returning so callers can rely on the
 * artifact surviving a process kill. Filesystem write stays best-effort
 * (disk is not the source of truth).
 */
export async function addArtifactSync(
  agent: string,
  kind: Artifact["kind"],
  title: string,
  content: string,
): Promise<Artifact> {
  const artifact: Artifact = {
    id: `artifact_${crypto.randomUUID()}`,
    agent,
    kind,
    title,
    content,
    createdAt: new Date().toISOString(),
  };
  await writeArtifactSync(artifact);
  swallowAndAudit("artifact.disk_write_sync", () => writeArtifactToDisk(artifact), {
    agentRole: artifact.agent,
    detail: { artifactId: artifact.id, kind: artifact.kind },
  });
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
  // Spec 31 Phase 7.C.c — companyId via the seam helper.
  const companyId = getActiveCompanyId();
  if (!companyId) {
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
export async function buildTaskMemoryOutput(task: Task, feedback?: string | null): Promise<string> {
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
    const artifact = await artifactsRepo.findArtifactById(getDb(), artifactId);
    if (!artifact?.content) continue;
    const snippet = artifact.content.slice(0, artifactBudget);
    sections.push(`\n--- Artifact: ${artifact.title} ---\n${snippet}`);
    artifactBudget -= snippet.length;
  }

  return sections.join("\n");
}

/**
 * Append a result string to a task's executor results (capped at 50).
 *
 * Sync export: `updateTask` is async (it persists to canonical), but
 * the in-memory append must happen on call. Fire-and-forget the DB
 * write through `swallowAndAudit` so failures surface to observability
 * instead of becoming an unhandled rejection.
 */
export function appendTaskResult(taskId: string, result: string) {
  swallowAndAudit("task.append_result", () =>
    updateTask(taskId, (task) => ({
      ...task,
      executorState: {
        ...task.executorState,
        results: [...task.executorState.results, result].slice(-50),
      },
    })),
    { detail: { taskId } },
  );
}

/**
 * Link an artifact to a task and emit a graph event for the sprint.
 *
 * `async` because the caller must wait for the updater to capture the
 * task's sprintId — the previous unawaited variant always read `prev`
 * as null since the updater hadn't run yet. Spec 31 Phase 7.B.4.2.
 */
export async function attachArtifactToTask(taskId: string, artifactId: string): Promise<void> {
  const captured: { sprintId: string | null | undefined } = { sprintId: null };
  await updateTask(taskId, (task) => {
    captured.sprintId = task.sprintId;
    return {
      ...task,
      artifactIds: task.artifactIds.includes(artifactId) ? task.artifactIds : [...task.artifactIds, artifactId],
    };
  });

  const sprintId = captured.sprintId ?? resolveActiveSprintId();
  if (sprintId) {
    const artifact = await artifactsRepo.findArtifactById(getDb(), artifactId);
    emitGraphArtifactProduced(sprintId, taskId, artifactId, artifact?.kind ?? "output", artifact?.title ?? artifactId);
  }
}

/** Update the task's local preview URL. Fire-and-forget. */
export function setTaskPreviewUrl(taskId: string, localPreviewUrl: string | null) {
  swallowAndAudit("task.set_preview_url", () =>
    updateTask(taskId, (task) => ({
      ...task,
      localPreviewUrl,
    })),
    { detail: { taskId } },
  );
}

/** Populate a task's title, description, DoD, and priority from a planner spec. Fire-and-forget. */
export function hydrateTaskFromSpec(taskId: string, spec: {
  title: string;
  description: string;
  problem_statement: string;
  deliverable: string;
  definition_of_done: string[];
  priority: Task["priority"];
}) {
  swallowAndAudit("task.hydrate_from_spec", () =>
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
    })),
    { detail: { taskId } },
  );
}

/** Append a plan step to the task's planner state (deduped, capped at 12). Fire-and-forget. */
export function appendTaskPlanStep(taskId: string, step: string) {
  swallowAndAudit("task.append_plan_step", () =>
    updateTask(taskId, (task) => ({
      ...task,
      plannerState: {
        ...task.plannerState,
        planSteps: uniqueStrings([...task.plannerState.planSteps, step], 12),
      },
    })),
    { detail: { taskId } },
  );
}

/** Record a command execution on the task's executor state (capped at 50). Fire-and-forget. */
export function appendTaskCommand(taskId: string, command: string) {
  swallowAndAudit("task.append_command", () =>
    updateTask(taskId, (task) => ({
      ...task,
      executorState: {
        ...task.executorState,
        currentCommand: command,
        commandsExecuted: [...task.executorState.commandsExecuted, command].slice(-50),
      },
    })),
    { detail: { taskId } },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// setTaskStatus — the big one: transitions, graph, audit, downstream promote,
// hippocampus memory, skill outcome tracking, pattern extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transition a task's status with full side-effects: graph instrumentation,
 * audit logging, escalation on block, downstream dependency promotion,
 * hippocampus memory, and skill outcome tracking.
 *
 * Spec 31 Phase 7.C.c — async because the downstream-promotion and
 * terminal-status branches read from canonical via buildSnapshotView.
 * Callers awaiting setTaskStatus are guaranteed graph + audit emits and
 * the in-memory updateTask have completed; the hippocampus / skill /
 * pattern paths remain fire-and-forget Promise chains as before.
 */
export async function setTaskStatus(taskId: string, status: Task["status"], feedback?: string | null): Promise<void> {
  // Spec 31 Phase 7.B.4.2 — capture prev via updater callback closure
  // instead of a separate snapshot.tasks.find() pre-read. Wrap in an object
  // so TS doesn't narrow the binding to its initial null value.
  // NOTE: updateTask is async — the updater callback only runs after the
  // DB read resolves. Without `await`, captured.prev would still be null
  // when read below, producing audit emits with previousStatus:"unknown".
  const captured: { prev: Task | null } = { prev: null };
  await updateTask(taskId, (task) => {
    captured.prev = task;
    return {
      ...task,
      status,
      verifierState: {
        ...task.verifierState,
        feedback: feedback ?? task.verifierState.feedback,
      },
    };
  });
  const prev = captured.prev;
  const prevStatus = prev?.status ?? "unknown";

  // ── Graph instrumentation (Spec 22) ──
  const sprintId = prev?.sprintId ?? resolveActiveSprintId();
  if (sprintId) {
    emitGraphStatusChanged(sprintId, taskId, prevStatus, status, prev?.assignedRole ?? "system", feedback ?? `${prevStatus} → ${status}`);
  }

  // Audit task transitions
  audit({
    companyId: prev?.companyId ?? getActiveCompanyId() ?? "",
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

  // Auto-promote downstream tasks when a task completes.
  // Spec 31 Phase 7.C.c — read from canonical instead of in-memory snapshot.
  if (status === "completed") {
    const companyId = prev?.companyId ?? getActiveCompanyId();
    if (!companyId) return; // No company → no downstream graph to promote.
    const snapshot = await buildSnapshotView(companyId);
    const completedTask = snapshot.tasks.find((t) => t.id === taskId);

    // Propagate artifacts from the completed task to its direct children
    if (completedTask && completedTask.artifactIds.length > 0) {
      for (const childId of completedTask.childTaskIds) {
        await updateTask(childId, (t) => ({
          ...t,
          incomingArtifactIds: uniqueStrings([...t.incomingArtifactIds, ...completedTask.artifactIds], MAX_INCOMING_ARTIFACT_IDS),
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
        await updateTask(task.id, (t) => ({
          ...t,
          status: "planned",
          incomingArtifactIds: uniqueStrings([...t.incomingArtifactIds, ...upstreamArtifactIds], MAX_INCOMING_ARTIFACT_IDS),
        }));
        if (task.assignedRole) {
          emitReactive(task.assignedRole, "task_dependency_met");
        }
      }
    }
  }

  // Hippocampus: store memory + update priming on terminal status.
  // Spec 31 Phase 7.C.c — canonical-backed snapshot for the terminal-status
  // side effects. Same companyId resolution as the completion branch above.
  if (["completed", "failed", "cancelled"].includes(status)) {
    const companyId = prev?.companyId ?? getActiveCompanyId();
    if (!companyId) return;
    const snapshot = await buildSnapshotView(companyId);
    const task = snapshot.tasks.find((t) => t.id === taskId);
    if (task) {
      const agent = getAgentByRole(snapshot, task.assignedRole);
      if (agent) {
        const outcome = status === "completed" ? "success" : status === "failed" ? "failure" : "partial";
        const memoryOutput = await buildTaskMemoryOutput(task, feedback);

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

        // Audit C2.11/C3.4 (F-409/F-375): hippocampus.processTaskCompletion
        // is fire-and-forget on a long-running embedding pipeline. Route the
        // failure through swallowAndAudit so DB or embedder outages surface
        // to operators instead of becoming a console.warn line.
        swallowAndAudit("hippocampus.task_completion", () =>
          hippocampus.processTaskCompletion({
            agentId: agent.id,
            taskId: task.id,
            companyId: snapshot.company.id,
            output: memoryOutput,
            outcome,
            taskTitle: task.title,
            role: task.assignedRole,
          }),
          { companyId: snapshot.company.id, agentRole: task.assignedRole, detail: { taskId: task.id } },
        );
      }

      // Spec 14 Phase 2: update success rates + trigger failure attribution
      if (status === "completed" || status === "failed") {
        // Audit C3.2 (F-279/F-331): the SkillMutator → ATA chain runs for
        // tens of minutes per skill proposal. Both legs route through
        // swallowAndAudit so failures land in the audit trail; without this
        // the user sees "skill proposed" but nothing ever happens.
        swallowAndAudit("skill_mutator.task_outcome", async () => {
          const mutation = await processTaskOutcome({
            taskId: task.id,
            taskTitle: task.title,
            taskDescription: task.description,
            assignedRole: task.assignedRole,
            companyId: snapshot.company.id,
            status,
            iterationCount: task.iterationCount,
            executionTrace: feedback ?? undefined,
          });
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

            swallowAndAudit("ata.pipeline_run", async () => {
              const result = await runATAPipeline(mutation.id);
              console.log(`[ATA] ${result.verdict.toUpperCase()} for ${mutation.id} (score=${result.reviewVerdict.overallScore}, revisions=${result.revisionCycles})`);
            },
              { companyId: snapshot.company.id, detail: { mutationId: mutation.id, taskId: task.id } },
            );
          }
        },
          { companyId: snapshot.company.id, agentRole: task.assignedRole, detail: { taskId: task.id } },
        );
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
        // Audit C2/C3 cleanup: route extractPattern through swallowAndAudit
        // so embedding-side failures don't disappear into a console.warn.
        swallowAndAudit("pattern_learner.extract", async () => {
          const pattern = await extractPattern({
            taskId: task.id,
            taskTitle: task.title,
            taskDescription: task.description,
            assignedRole: task.assignedRole,
            companyId: snapshot.company.id,
            outcome: patternOutcome,
            trajectory: feedback ?? undefined,
            activeSkillIds,
            sprintId: task.sprintId ?? snapshot.company.currentSprintId ?? null,
          });
          if (pattern.usageCount === 1) {
            console.log(`[PatternLearner] New pattern ${pattern.id} for "${task.title.slice(0, 40)}"`);
          }
        },
          { companyId: snapshot.company.id, agentRole: task.assignedRole, detail: { taskId: task.id } },
        );
      }
    }
  }
}
