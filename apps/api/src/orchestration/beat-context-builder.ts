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
import type { BeatContext, CompanySnapshot, IncomingHandoff, HandoffKind, HandoffUrgency, Task, TrustBand } from "@arceus/contracts";
import type { Role } from "../../../../.opencode/agent/config.js";
import { getAllowedArceusTools } from "../../../../.opencode/agent/config.js";
import { getSnapshot } from "../persistence/store.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { resolveIncomingArtifacts } from "../prompts/artifacts.js";
import { productDir } from "./state.js";

/**
 * Statuses that count as "the agent has work to do this beat".
 *
 * Mirrors the task-status enum in `@arceus/contracts`. Matters because:
 *   - `runBeat` skips the prompt entirely when the count is zero
 *     (the no-work guard, see run-beat.ts).
 *   - The state-render and procedure block surface the same list to the LLM.
 *
 * Excludes terminal states (`completed`, `failed`, `cancelled`) and
 * `verifying` (work is done, awaiting QA — agent shouldn't redo it).
 *
 * Bug history: this used to be `["ready", "in_progress", "blocked"]` —
 * `"ready"` isn't in the enum at all, and `"created"`/`"planned"` were
 * missing, so freshly-spawned governance tasks (e.g. "Plan Sprint N")
 * were invisible and the CEO would no-work-skip its own assignment.
 */
const OPEN_TASK_STATUSES: ReadonlyArray<Task["status"]> = [
  "created",
  "planned",
  "in_progress",
  "blocked",
];

// ── BeatContext builder ──────────────────────────────────

async function computeTrustBand(_role: Role, _companyId: string): Promise<TrustBand> {
  return "standard"; // v1 stub — full policy matrix Phase 7+
}

// ── Incoming handoffs drainer (spec 27 §6) ───────────────

const URGENCY_RANK: Record<HandoffUrgency, number> = { high: 0, normal: 1, low: 2 };
const MAX_INCOMING_HANDOFFS = 5;
const HANDOFF_RECENCY_MS = 24 * 60 * 60 * 1000; // last 24h

/**
 * Read the agent's delegation-typed memory units and project them into the
 * IncomingHandoff shape for beat-context surfacing. Handoffs are stored as
 * MemoryUnit entries with type="delegation" and tag-encoded metadata
 * (from:<role>, kind:<kind>, urgency:<urgency>, handoffId:<id>).
 *
 * Sorted by urgency desc then receivedAt desc; capped at MAX_INCOMING_HANDOFFS.
 * Only surfaces handoffs received in the last 24h to avoid replaying stale ones.
 */
function drainIncomingHandoffs(role: Role): IncomingHandoff[] {
  const snapshot = getSnapshot();
  const agent = snapshot.agents.find((a) => a.role === role);
  if (!agent) return [];

  const cutoff = Date.now() - HANDOFF_RECENCY_MS;
  const delegations = snapshot.memoryUnits.filter(
    (u) => u.agentId === agent.id && u.type === "delegation" && Date.parse(u.createdAt) >= cutoff,
  );

  const projected: IncomingHandoff[] = delegations.map((u) => {
    const tags = u.tags ?? [];
    const getTagValue = (prefix: string): string | null => {
      const found = tags.find((t) => t.startsWith(`${prefix}:`));
      return found ? found.slice(prefix.length + 1) : null;
    };
    const fromRole = (getTagValue("from") ?? "unknown") as IncomingHandoff["fromRole"];
    const kind = (getTagValue("kind") ?? "context_transfer") as HandoffKind;
    const urgency = (getTagValue("urgency") ?? "normal") as HandoffUrgency;
    const handoffId = getTagValue("handoffId") ?? u.id;
    const relatedArtifactIds = tags
      .filter((t) => t.startsWith("artifact:"))
      .map((t) => t.slice("artifact:".length));

    return {
      handoffId,
      fromRole,
      kind,
      urgency,
      excerpt: (u.content ?? u.summary ?? "").slice(0, 200),
      memoryId: u.id,
      relatedArtifactIds,
      receivedAt: u.createdAt,
    };
  });

  projected.sort((a, b) => {
    const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    return b.receivedAt.localeCompare(a.receivedAt);
  });

  return projected.slice(0, MAX_INCOMING_HANDOFFS);
}

export async function buildBeatContext(
  role: Role,
  companyId: string,
  beatId: string,
  sessionId: string,
): Promise<BeatContext> {
  // Active sprint at beat start (or null if the company has no active sprint).
  // Captured here rather than re-derived per consumer so spec-32 emit sites
  // can read `ctx.sprintId` without touching the snapshot directly.
  const currentSprintId = getSnapshot().company.currentSprintId ?? null;

  return {
    beatId,
    sessionId,
    companyId,
    sprintId: currentSprintId,
    role,
    trustBand: await computeTrustBand(role, companyId),
    allowedTools: getAllowedArceusTools(role),
    startedAt: new Date().toISOString(),
    incomingHandoffs: drainIncomingHandoffs(role),
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

/**
 * Count of role-assigned tasks in workable states. Used by `runBeat` to skip
 * the prompt entirely when an agent has nothing to do (avoids filler-work
 * hallucination from a bored LLM).
 */
export function countOpenTasksForRole(role: Role): number {
  const snapshot = getSnapshot();
  return snapshot.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  ).length;
}

function renderOpenTasksForRole(companyId: string, role: Role): string {
  const snapshot = getSnapshot();
  const tasks = snapshot.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  );
  if (tasks.length === 0) return "## Your Tasks\n\n_No open tasks._";
  const lines = ["## Your Tasks", ""];
  for (const t of tasks) {
    const unmetDeps = (t.dependsOnTaskIds ?? [])
      .map((depId) => snapshot.tasks.find((d) => d.id === depId))
      .filter((d): d is NonNullable<typeof d> => !!d && !(["completed", "verified"] as string[]).includes(d.status));
    const readiness = unmetDeps.length > 0
      ? ` ⛔ NOT CLAIMABLE — waiting on: ${unmetDeps.map((d) => `"${d.title}" [${d.status}]`).join(", ")}`
      : " ✅ claimable";
    lines.push(`- [${t.status}] **${t.title}** (${t.id})${readiness}`);
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
    renderBeatProcedure(companyId, role),
  ];
  return sections.join("\n\n---\n\n");
}

/**
 * Tells the agent the workflow contract for this beat: claim → work → complete.
 * Without this block agents invent filler work to fill the prompt window.
 */
function renderBeatProcedure(companyId: string, role: Role): string {
  const snapshot = getSnapshot();
  const myTasks = snapshot.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  );
  const claimable = myTasks.filter((t) => {
    const unmet = (t.dependsOnTaskIds ?? []).filter((depId) => {
      const dep = snapshot.tasks.find((d) => d.id === depId);
      return !dep || !(["completed", "verified"] as string[]).includes(dep.status);
    });
    return unmet.length === 0;
  });
  if (myTasks.length === 0) {
    return [
      "## How to work this beat",
      "",
      "You have **no open tasks**. End your turn now. Do not call any tools.",
      "Do not invent work. Do not create placeholder or no-op artifacts.",
    ].join("\n");
  }
  if (claimable.length === 0) {
    return [
      "## How to work this beat",
      "",
      "You have open tasks but **none are claimable** — every one is waiting on an upstream dependency (see ⛔ markers in `## Your Tasks`).",
      "End your turn now. Do not call `task_claim` (it will return `deps_unmet`). Do not invent work.",
    ].join("\n");
  }
  return [
    "## How to work this beat — Task Lifecycle Contract",
    "",
    "This is a **strict 3-step contract**. Skipping a step or going out of order is a bug.",
    "",
    "**Step 1 — Claim**",
    "- Pick **one** task ID from `## Your Tasks` that is marked ✅ claimable.",
    "- Use the EXACT id from that list. Never invent or modify ids.",
    "- Call `task_claim({ taskId, reason })` **before any other mutating tool**.",
    "- If it returns `ok: false` for ANY reason (`not_found`, `wrong_role`, `deps_unmet`, `already_claimed`, `not_claimable`): **stop, end your turn**. Do not retry. Do not call other tools.",
    "",
    "**Step 2 — Work**",
    "- Do the work using your other tools (edits, builds, `artifact_create`, `task_append_result`, etc.).",
    "- Every meaningful artifact you produce should be created with `artifact_create` (it auto-attaches to the claimed task).",
    "- Use `task_append_result` to log notes/evidence as you go.",
    "",
    "**Step 3 — Complete (MANDATORY)**",
    "- When the task's definition-of-done is met, call `task_complete({ taskId, evidence })`.",
    "- `task_complete` is what unblocks downstream tasks. **Without it, every dependent role stalls.**",
    "- If you cannot complete the task this beat (genuinely blocked), call `task_block({ taskId, reason })` instead.",
    "- Never end a beat with a claimed-but-not-completed task unless you called `task_block`.",
    "",
    "**Step 4 — End turn**",
    "- After `task_complete` (or `task_block`), end your turn. Do not invent extra work.",
  ].join("\n");
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

/**
 * Banner for any urgency=high handoffs. Renders at the top of the beat prompt
 * so the agent sees urgent cross-role context before task details. Empty if
 * no high-urgency handoffs are waiting.
 */
function renderIncomingHandoffsBanner(handoffs: IncomingHandoff[]): string {
  const high = handoffs.filter((h) => h.urgency === "high");
  if (high.length === 0) return "";
  const lines = [`## ⚠ High-Priority Handoffs (${high.length})`, ""];
  for (const h of high) {
    const snippet = h.excerpt.length > 120 ? `${h.excerpt.slice(0, 120)}…` : h.excerpt;
    lines.push(`- **[${h.kind}] From ${h.fromRole}:** ${snippet}`);
    lines.push(`  - handoff id: \`${h.handoffId}\` · memory id: \`${h.memoryId}\``);
  }
  lines.push("");
  lines.push("_Retrieve full content with `memory_search({ scope: \"company\", query: \"<keywords>\" })` or by memory id._");
  return lines.join("\n");
}

/**
 * Full incoming-handoffs section. Shows all handoffs (high, normal, low)
 * sorted by urgency desc then receivedAt desc. Rendered after role memory.
 */
function renderIncomingHandoffsSection(handoffs: IncomingHandoff[]): string {
  if (handoffs.length === 0) return "";
  const lines = [`## Incoming Handoffs (${handoffs.length})`, ""];
  for (const h of handoffs) {
    lines.push(`### From ${h.fromRole} — ${h.kind} (${h.urgency})`);
    lines.push(h.excerpt);
    lines.push(`- Memory id: \`${h.memoryId}\``);
    if (h.relatedArtifactIds.length > 0) {
      lines.push(`- Related artifacts: ${h.relatedArtifactIds.map((id) => `\`${id}\``).join(", ")}`);
    }
    lines.push(`- Received: ${h.receivedAt}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderBudget(snapshot: CompanySnapshot): string {
  const c = snapshot.company;
  if (c.budgetCents <= 0) return "";
  const pct = ((c.spentCents / c.budgetCents) * 100).toFixed(0);
  return `## Budget\n\n${pct}% used (${c.spentCents}¢ of ${c.budgetCents}¢)`;
}

// ── Unified beat prompt ──────────────────────────────────
//
// Skill catalog is no longer rendered into the prompt body. Skills reach
// the agent via filesystem materialization (.opencode/skills/<slug>/SKILL.md)
// — see materializeBeatSkills + OpenCode's native skill loader. (Spec 23 Pass 2)

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
  const incomingHandoffs = drainIncomingHandoffs(role);
  const sections = [
    renderIncomingHandoffsBanner(incomingHandoffs),
    renderTaskContext(task),
    renderWorkspaceContext(existingFiles),
    renderCompanyState(companyId),
    renderBudget(snapshot),
    renderSprintHistory(snapshot),
    renderOpenTasksForRole(companyId, role),
    renderRecentArtifacts(companyId, 10),
    renderRoleMemory(role, companyId),
    renderIncomingHandoffsSection(incomingHandoffs),
    renderLastProgressNotes(role, companyId, 5),
    renderUpstreamArtifacts(task),
  ].filter(Boolean);
  return sections.join("\n\n---\n\n");
}
