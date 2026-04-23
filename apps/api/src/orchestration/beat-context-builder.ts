/**
 * buildBeatContext + renderStateForAgent + buildUnifiedBeatPrompt.
 *
 * Three concerns:
 * - BeatContext: metadata the plugin + MCP server resolve against.
 * - renderStateForAgent: role-agnostic state of the world.
 * - buildUnifiedBeatPrompt: the full prompt body for any role's beat.
 *
 * Vision: "The orchestrator builds a view of the world, wakes one agent,
 * and gets out of the way." All role-specific instructions live in the
 * soul (systemPrompt). This module provides only state — no role branching.
 *
 * Phase 6.5 — Package I.
 */
import type { BeatContext, CompanySnapshot, Task, TrustBand } from "@arceus/contracts";
import type { Role } from "../../../../.opencode/agent/config.js";
import { getAllowedArceusTools } from "../../../../.opencode/agent/config.js";
import { getSnapshot } from "../persistence/store.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { resolveIncomingArtifacts } from "../prompts/artifacts.js";
import { productDir } from "./state.js";

// ── BeatContext builder ──────────────────────────────────

async function computeTrustBand(_role: Role, _companyId: string): Promise<TrustBand> {
  return "standard"; // v1 stub — full policy matrix Phase 7+
}

export async function buildBeatContext(
  role: Role,
  companyId: string,
  beatId: string,
  sessionId: string,
): Promise<BeatContext> {
  return {
    beatId,
    sessionId,
    companyId,
    role,
    trustBand: await computeTrustBand(role, companyId),
    allowedTools: getAllowedArceusTools(role),
    startedAt: new Date().toISOString(),
  };
}

// ── State renderer ───────────────────────────────────────

function renderCompanyState(companyId: string): string {
  const snapshot = getSnapshot();
  const c = snapshot.company;
  const sprint = snapshot.sprints.find((s) => s.id === c.currentSprintId);
  const lines = [
    "## Company State",
    `- **Company:** ${c.name} (${c.id})`,
    `- **Status:** ${c.status}`,
    `- **Goal:** ${c.goal}`,
  ];
  if (sprint) {
    lines.push(`- **Sprint ${sprint.number}:** ${sprint.goal} [${sprint.status}]`);
  }
  return lines.join("\n");
}

function renderOpenTasksForRole(companyId: string, role: Role): string {
  const snapshot = getSnapshot();
  const tasks = snapshot.tasks.filter(
    (t) => t.assignedRole === role && ["ready", "in_progress", "blocked"].includes(t.status),
  );
  if (tasks.length === 0) return "## Your Tasks\n\n_No open tasks._";
  const lines = ["## Your Tasks", ""];
  for (const t of tasks) {
    const deps = t.dependsOnTaskIds?.length
      ? ` (depends on: ${t.dependsOnTaskIds.join(", ")})`
      : "";
    lines.push(`- [${t.status}] **${t.title}** (${t.id})${deps}`);
    if (t.description) lines.push(`  ${t.description}`);
  }
  return lines.join("\n");
}

function renderRecentArtifacts(companyId: string, limit: number): string {
  const snapshot = getSnapshot();
  const recent = snapshot.artifacts.slice(-limit);
  if (recent.length === 0) return "## Recent Artifacts\n\n_No artifacts yet._";
  const lines = ["## Recent Artifacts", ""];
  for (const a of recent) {
    lines.push(`- **${a.title}** (${a.id}) — ${a.kind}`);
  }
  return lines.join("\n");
}

function renderRoleMemory(role: Role, companyId: string): string {
  const snapshot = getSnapshot();
  const agent = snapshot.agents.find((a) => a.role === role);
  if (!agent) return "## Role Memory\n\n_No agent found._";
  const mem = snapshot.memories.find((m) => m.agentId === agent.id);
  if (!mem) return "## Role Memory\n\n_No memory entries._";
  const lines = ["## Role Memory", ""];
  if (mem.currentFocus.length > 0) {
    lines.push("**Focus:** " + mem.currentFocus.join(", "));
  }
  if (mem.recentLearnings.length > 0) {
    lines.push("**Learnings:** " + mem.recentLearnings.join("; "));
  }
  if (mem.openBlockers.length > 0) {
    lines.push("**Blockers:** " + mem.openBlockers.join("; "));
  }
  return lines.join("\n");
}

function renderLastProgressNotes(role: Role, companyId: string, limit: number): string {
  const snapshot = getSnapshot();
  const agent = snapshot.agents.find((a) => a.role === role);
  if (!agent) return "## Progress Notes\n\n_No recent progress notes._";
  // Memory units from this agent serve as progress notes
  const units = snapshot.memoryUnits
    .filter((u) => u.agentId === agent.id)
    .slice(-limit);
  if (units.length === 0) return "## Progress Notes\n\n_No recent progress notes._";
  const lines = ["## Progress Notes", ""];
  for (const u of units) {
    lines.push(`- ${u.summary || u.content}`);
  }
  return lines.join("\n");
}

export function renderStateForAgent(role: Role, companyId: string): string {
  const sections = [
    renderCompanyState(companyId),
    renderOpenTasksForRole(companyId, role),
    renderRecentArtifacts(companyId, 10),
    renderRoleMemory(role, companyId),
    renderLastProgressNotes(role, companyId, 5),
  ];
  return sections.join("\n\n---\n\n");
}

// ── Task-specific context ────────────────────────────────

function renderTaskContext(task: Task): string {
  const lines = [
    "## Assigned Task",
    `- **Title:** ${task.title}`,
    `- **ID:** ${task.id}`,
    `- **Description:** ${task.description}`,
    `- **Problem statement:** ${task.problemStatement}`,
    `- **Deliverable:** ${task.deliverable}`,
    `- **Definition of done:**`,
    ...task.definitionOfDone.map((item) => `  - ${item}`),
  ];
  return lines.join("\n");
}

function renderWorkspaceContext(existingFiles?: string[]): string {
  const preview = getLocalPreviewState();
  const lines = [
    "## Workspace",
    `- **Product directory:** ${productDir}`,
    `- **Preview status:** ${preview.status}`,
  ];
  if (preview.url) lines.push(`- **Preview URL:** ${preview.url}`);
  if (preview.entryUrl) lines.push(`- **Entry URL:** ${preview.entryUrl}`);
  if (preview.validationUrl) lines.push(`- **Validation URL:** ${preview.validationUrl}`);
  if (preview.validationStrategy) lines.push(`- **Validation strategy:** ${preview.validationStrategy}`);
  if (preview.targetKind) lines.push(`- **Target kind:** ${preview.targetKind}`);
  if (preview.runtime) lines.push(`- **Runtime:** ${preview.runtime}`);
  if (preview.framework) lines.push(`- **Framework:** ${preview.framework}`);

  if (existingFiles && existingFiles.length > 0) {
    lines.push("", `### Existing files (${existingFiles.length})`);
    const shown = existingFiles.slice(0, 100);
    for (const f of shown) lines.push(`- ${f}`);
    if (existingFiles.length > 100) lines.push(`... and ${existingFiles.length - 100} more`);
  }

  return lines.join("\n");
}

function renderSprintHistory(snapshot: CompanySnapshot): string {
  const completedSprints = snapshot.sprints
    .filter((s) => s.status === "completed")
    .sort((a, b) => b.number - a.number)
    .slice(0, 3);

  if (completedSprints.length === 0) return "## Previous Sprints\n\n_This is the first sprint — no prior history._";

  const lines = ["## Previous Sprints", ""];
  for (const sprint of completedSprints) {
    const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === sprint.id);
    const completed = sprintTasks.filter((t) => t.status === "completed");
    const failed = sprintTasks.filter((t) => t.status === "failed");
    const blocked = sprintTasks.filter((t) => t.status === "blocked");

    lines.push(`### Sprint ${sprint.number}: "${sprint.goal}"`);
    lines.push(`Status: ${sprint.status} | ${completed.length} completed, ${failed.length} failed, ${blocked.length} blocked`);
    if (completed.length > 0) {
      lines.push("Completed:");
      for (const t of completed) lines.push(`  - ${t.title} (${t.assignedRole})`);
    }
    if (failed.length > 0) {
      lines.push("Failed:");
      for (const t of failed) lines.push(`  - ${t.title} (${t.assignedRole})`);
    }
    if (blocked.length > 0) {
      lines.push("Blocked:");
      for (const t of blocked) lines.push(`  - ${t.title} (${t.assignedRole})`);
    }
    lines.push("");
  }

  // Carried-forward items from last completed sprint
  const lastSprint = completedSprints[0];
  if (lastSprint) {
    const carryForward = snapshot.tasks.filter(
      (t) => t.sprintId === lastSprint.id && ["failed", "blocked"].includes(t.status),
    );
    if (carryForward.length > 0) {
      lines.push("### Carried-Forward Items");
      for (const t of carryForward) lines.push(`- ${t.title} (${t.assignedRole}, was ${t.status})`);
    }
  }

  return lines.join("\n");
}

function renderUpstreamArtifacts(task: Task): string {
  const upstreamLines = resolveIncomingArtifacts(task);
  if (upstreamLines.length === 0) return "";
  return upstreamLines.join("\n");
}

function renderBudget(snapshot: CompanySnapshot): string {
  const c = snapshot.company;
  if (c.budgetCents <= 0) return "";
  const pct = ((c.spentCents / c.budgetCents) * 100).toFixed(0);
  return `## Budget\n\n${pct}% used (${c.spentCents}¢ of ${c.budgetCents}¢)`;
}

// ── Unified beat prompt ──────────────────────────────────

/**
 * Build the full prompt body for any role's beat. Role-agnostic —
 * all role-specific instructions live in the soul (systemPrompt).
 * This is pure state: task, workspace, company, history, artifacts.
 */
export function buildUnifiedBeatPrompt(
  task: Task,
  role: Role,
  companyId: string,
  snapshot: CompanySnapshot,
  existingFiles?: string[],
): string {
  const sections = [
    renderTaskContext(task),
    renderWorkspaceContext(existingFiles),
    renderCompanyState(companyId),
    renderBudget(snapshot),
    renderSprintHistory(snapshot),
    renderOpenTasksForRole(companyId, role),
    renderRecentArtifacts(companyId, 10),
    renderRoleMemory(role, companyId),
    renderLastProgressNotes(role, companyId, 5),
    renderUpstreamArtifacts(task),
  ].filter(Boolean);
  return sections.join("\n\n---\n\n");
}
