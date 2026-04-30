/**
 * buildBeatContext + renderStateForAgent.
 *
 * Two concerns:
 * - BeatContext: metadata the plugin + MCP server resolve against.
 * - renderStateForAgent: role-agnostic state of the world.
 *
 * Vision: "The orchestrator builds a view of the world, wakes one agent,
 * and gets out of the way." All role-specific instructions live in the
 * soul (systemPrompt). This module provides only state — no role branching.
 *
 * Spec 31 Phase 7.B.3 — every snapshot read replaced by a single
 * `loadBeatRenderContext(companyId, role)` batch fetch (one
 * `Promise.all` per beat). Renderers are pure functions over the
 * `BeatRenderContext` so the hot path makes ~7 parallel queries
 * instead of 10+ in-memory derefs against a stale snapshot.
 */
import type {
  AgentIdentity,
  Artifact,
  BeatContext,
  Company,
  IncomingHandoff,
  HandoffKind,
  HandoffUrgency,
  MemorySummary,
  Sprint,
  Task,
} from "@arceus/contracts";
import { parseRoleStrict } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as artifactsRepo from "@arceus/db/src/repos/artifacts.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as memorySummariesRepo from "@arceus/db/src/repos/memory_summaries.js";
import * as memoryUnitsRepo from "@arceus/db/src/repos/memory_units.js";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import type { Role } from "../../../../.opencode/agent/config.js";
import { getAllowedArceusTools } from "../../../../.opencode/agent/config.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { resolveIncomingArtifacts } from "../prompts/artifacts.js";
import { productDir } from "./state.js";
import { computeTrustBand } from "../governance/trust.js";

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
 */
const OPEN_TASK_STATUSES: readonly Task["status"][] = [
  "created",
  "planned",
  "in_progress",
  "blocked",
];

const URGENCY_RANK: Record<HandoffUrgency, number> = { high: 0, normal: 1, low: 2 };
const MAX_INCOMING_HANDOFFS = 5;
const HANDOFF_RECENCY_MS = 24 * 60 * 60 * 1000; // last 24h

// ── BeatRenderContext: the per-beat batch-fetched view ────────

/**
 * Per-beat snapshot of every entity the renderers need. Built once
 * by `loadBeatRenderContext` via `Promise.all`; each pure renderer
 * filters/derives from it without touching the in-memory store.
 *
 * Sized to the renderer surface — adding a new render function that
 * needs a new entity = extending this type + the loader.
 */
/** Compact per-agent identity slice the renderers need. */
interface BeatAgentSlice {
  id: string;
  role: AgentIdentity["role"];
  displayName: string;
}

/**
 * Compact per-memory-unit slice — what the progress-notes and
 * handoffs renderers need. Mirrors the canonical row shape, dates
 * pre-stringified.
 */
interface BeatMemoryUnitSlice {
  id: string;
  agentId: string;
  type: string;
  content: string;
  /** Set to `content.slice(0, 200)` when the canonical row has no summary column. */
  summary: string;
  tags: string[];
  createdAt: string;
}

export interface BeatRenderContext {
  company: Company | null;
  agents: readonly BeatAgentSlice[];
  sprints: Sprint[];
  tasks: Task[];
  /** Recent first; bounded by `RECENT_ARTIFACT_LIMIT`. */
  artifacts: Artifact[];
  /** All summaries for the company; renderers filter by agentId. */
  memorySummaries: MemorySummary[];
  /**
   * Memory units for the role's agent only. Loaded lazily after
   * agent lookup; `null` when the role has no agent.
   */
  roleMemoryUnits: BeatMemoryUnitSlice[] | null;
  /** The agent for the requesting role, resolved once at load time. */
  roleAgent: BeatAgentSlice | null;
}

const RECENT_ARTIFACT_LIMIT = 50;
const MAX_AGENT_MEMORY_UNITS = 100;

/**
 * Single batch fetch per beat. Parallelises every entity load via
 * `Promise.all`; the role-scoped memory units load is sequential
 * because it needs the resolved agent id from the companies+agents
 * step.
 *
 * Performance note: ~7 parallel queries / beat. The
 * `db:explain-audit` script tracks latency for these hot paths.
 */
export async function loadBeatRenderContext(
  companyId: string,
  role: Role,
): Promise<BeatRenderContext> {
  const db = getDb();
  const [company, agentRows, sprintRows, tasks, artifactRows, summaries] = await Promise.all([
    companiesRepo.findByIdHydrated(db, companyId),
    agentsRepo.listAgentsByCompany(db, companyId),
    sprintsRepo.listSprintsByCompany(db, companyId),
    tasksRepo.listByCompanyHydrated(db, companyId),
    artifactsRepo.listArtifactsByCompany(db, companyId, RECENT_ARTIFACT_LIMIT),
    memorySummariesRepo.listByCompany(db, companyId),
  ]);

  const agents: BeatAgentSlice[] = agentRows.map((row) => ({
    id: row.id,
    role: parseRoleStrict(row.role),
    displayName: row.displayName,
  }));
  const sprints = sprintRows.map(sprintsRepo.rowToSprint);
  const artifacts = artifactRows.map(artifactsRepo.rowToArtifact);
  const memorySummaries = summaries.map(memorySummariesRepo.rowToSummary);

  const roleAgent = agents.find((a) => a.role === role) ?? null;
  const memoryUnitRows = roleAgent
    ? await memoryUnitsRepo.listMemoryUnitsByAgent(db, roleAgent.id, undefined, MAX_AGENT_MEMORY_UNITS)
    : null;
  const roleMemoryUnits: BeatMemoryUnitSlice[] | null = memoryUnitRows
    ? memoryUnitRows.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        type: row.type,
        content: row.content,
        /** Canonical schema has no `summary` column — derive from content. */
        summary: row.content.slice(0, 200),
        tags: row.tags ?? [],
        createdAt: row.createdAt.toISOString(),
      }))
    : null;

  return { company, agents, sprints, tasks, artifacts, memorySummaries, roleMemoryUnits, roleAgent };
}

// ── Incoming handoffs drainer (spec 27 §6) ───────────────

/**
 * Project the role's `delegation`-typed memory units into the
 * `IncomingHandoff` shape. Pure — operates on the pre-fetched
 * `roleMemoryUnits` slice of `BeatRenderContext`.
 */
function drainIncomingHandoffs(ctx: BeatRenderContext): IncomingHandoff[] {
  if (!ctx.roleMemoryUnits) return [];

  const cutoff = Date.now() - HANDOFF_RECENCY_MS;
  const delegations = ctx.roleMemoryUnits.filter(
    (u) => u.type === "delegation" && Date.parse(u.createdAt) >= cutoff,
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

// ── BeatContext builder ──────────────────────────────────

export async function buildBeatContext(
  role: Role,
  companyId: string,
  beatId: string,
  sessionId: string,
): Promise<BeatContext> {
  const ctx = await loadBeatRenderContext(companyId, role);
  return {
    beatId,
    sessionId,
    companyId,
    sprintId: ctx.company?.currentSprintId ?? null,
    role,
    trustBand: await computeTrustBand(role, companyId),
    allowedTools: getAllowedArceusTools(role),
    startedAt: new Date().toISOString(),
    incomingHandoffs: drainIncomingHandoffs(ctx),
  };
}

// ── State renderer (pure functions over BeatRenderContext) ────

function renderCompanyState(ctx: BeatRenderContext): string {
  if (!ctx.company) return "## Company State\n\n_Company not yet bootstrapped._";
  const c = ctx.company;
  const sprint = ctx.sprints.find((s) => s.id === c.currentSprintId);
  const roster = ctx.agents
    .map((a) => a.role)
    .sort()
    .join(", ");
  const lines = [
    "## Company State",
    `- **Company:** ${c.name} (${c.id})`,
    `- **Status:** ${c.status}`,
    `- **Goal:** ${c.goal}`,
    `- **Hired roles:** [${roster || "none"}] — when assigning tasks (e.g. in \`sprint_create\`), \`assigned_role\` MUST be one of these. Do NOT invent roles like "pm" or "qa" if they are not listed.`,
  ];
  if (sprint) {
    lines.push(`- **Sprint ${sprint.number}:** ${sprint.goal} [${sprint.status}]`);
  }
  return lines.join("\n");
}

/**
 * Count of role-assigned tasks in workable states. Used by `runBeat`
 * to skip the prompt entirely when an agent has nothing to do
 * (avoids filler-work hallucination from a bored LLM).
 */
export function countOpenTasks(ctx: BeatRenderContext, role: Role): number {
  return ctx.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  ).length;
}

/** Snapshot of what the role sees in `## Your Tasks` (for diagnostic events). */
export function summarizeShownTasks(
  ctx: BeatRenderContext,
  role: Role,
): { id: string; title: string; status: string; claimable: boolean }[] {
  return ctx.tasks
    .filter((t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status))
    .map((t) => {
      const unmet = (t.dependsOnTaskIds ?? []).some((depId) => {
        const dep = ctx.tasks.find((d) => d.id === depId);
        return !dep || !(["completed", "verified"] as string[]).includes(dep.status);
      });
      return { id: t.id, title: t.title, status: t.status, claimable: !unmet };
    });
}

function renderOpenTasksForRole(ctx: BeatRenderContext, role: Role): string {
  const tasks = ctx.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  );
  if (tasks.length === 0) return "## Your Tasks\n\n_No open tasks._";
  const lines = ["## Your Tasks", ""];
  for (const t of tasks) {
    const unmetDeps = (t.dependsOnTaskIds ?? [])
      .map((depId) => ctx.tasks.find((d) => d.id === depId))
      .filter((d): d is NonNullable<typeof d> => !!d && !(["completed", "verified"] as string[]).includes(d.status));
    const readiness = unmetDeps.length > 0
      ? ` ⛔ NOT CLAIMABLE — waiting on: ${unmetDeps.map((d) => `"${d.title}" [${d.status}]`).join(", ")}`
      : " ✅ claimable";
    lines.push(`- [${t.status}] **${t.title}** (${t.id})${readiness}`);
    if (t.description) lines.push(`  ${t.description}`);
  }
  return lines.join("\n");
}

function renderRecentArtifacts(ctx: BeatRenderContext, limit: number): string {
  /** Repo returns recent-first; take first `limit`. */
  const recent = ctx.artifacts.slice(0, limit);
  if (recent.length === 0) return "## Recent Artifacts\n\n_No artifacts yet._";
  const lines = ["## Recent Artifacts", ""];
  for (const a of recent) {
    lines.push(`- **${a.title}** (${a.id}) — ${a.kind}`);
  }
  return lines.join("\n");
}

function renderRoleMemory(ctx: BeatRenderContext): string {
  if (!ctx.roleAgent) return "## Role Memory\n\n_No agent found._";
  const mem = ctx.memorySummaries.find((m) => m.agentId === ctx.roleAgent!.id);
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

function renderLastProgressNotes(ctx: BeatRenderContext, limit: number): string {
  if (!ctx.roleAgent) return "## Progress Notes\n\n_No recent progress notes._";
  if (!ctx.roleMemoryUnits) return "## Progress Notes\n\n_No recent progress notes._";
  /** Memory units from this agent serve as progress notes. */
  const units = ctx.roleMemoryUnits.slice(-limit);
  if (units.length === 0) return "## Progress Notes\n\n_No recent progress notes._";
  const lines = ["## Progress Notes", ""];
  for (const u of units) {
    lines.push(`- ${u.summary || u.content}`);
  }
  return lines.join("\n");
}

function renderBudget(ctx: BeatRenderContext): string {
  if (!ctx.company || ctx.company.budgetCents <= 0) return "";
  const c = ctx.company;
  const pct = ((c.spentCents / c.budgetCents) * 100).toFixed(0);
  return `## Budget\n\n${pct}% used (${c.spentCents}¢ of ${c.budgetCents}¢)`;
}

function renderSprintHistory(ctx: BeatRenderContext): string {
  const completedSprints = ctx.sprints
    .filter((s) => s.status === "completed")
    .sort((a, b) => b.number - a.number)
    .slice(0, 3);

  if (completedSprints.length === 0) return "## Previous Sprints\n\n_This is the first sprint — no prior history._";

  const lines = ["## Previous Sprints", ""];
  for (const sprint of completedSprints) {
    const sprintTasks = ctx.tasks.filter((t) => t.sprintId === sprint.id);
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
    const carryForward = ctx.tasks.filter(
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
 * Banner for any urgency=high handoffs. Renders at the top of the beat
 * prompt so the agent sees urgent cross-role context before task
 * details. Empty if no high-urgency handoffs are waiting.
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

/**
 * Tells the agent the workflow contract for this beat: claim → work → complete.
 * Without this block agents invent filler work to fill the prompt window.
 */
function renderBeatProcedure(ctx: BeatRenderContext, role: Role): string {
  const myTasks = ctx.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  );
  const claimable = myTasks.filter((t) => {
    const unmet = (t.dependsOnTaskIds ?? []).filter((depId) => {
      const dep = ctx.tasks.find((d) => d.id === depId);
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

// ── Public renderers ─────────────────────────────────────

/**
 * Compose the full role-state prompt section. Async because it does
 * one batch fetch of `BeatRenderContext`; the renderers themselves
 * are pure.
 */
export async function renderStateForAgent(role: Role, companyId: string): Promise<string> {
  const ctx = await loadBeatRenderContext(companyId, role);
  const sections = [
    renderCompanyState(ctx),
    renderOpenTasksForRole(ctx, role),
    renderRecentArtifacts(ctx, 10),
    renderRoleMemory(ctx),
    renderLastProgressNotes(ctx, 5),
    renderBeatProcedure(ctx, role),
  ];
  return sections.join("\n\n---\n\n");
}

/**
 * Convenience wrapper that batch-loads once and returns every read
 * a beat needs (state text + open task count + shown task summary).
 * Call this from `run-beat.ts` instead of three separate awaits to
 * avoid duplicate batch fetches.
 */
export async function prepareBeatRender(
  role: Role,
  companyId: string,
  task?: Task,
  existingFiles?: string[],
): Promise<{
  ctx: BeatRenderContext;
  stateText: string;
  openTaskCount: number;
  shownTasks: ReturnType<typeof summarizeShownTasks>;
  unifiedPrompt: string | null;
}> {
  const ctx = await loadBeatRenderContext(companyId, role);
  const incomingHandoffs = drainIncomingHandoffs(ctx);

  const baseSections = [
    renderCompanyState(ctx),
    renderOpenTasksForRole(ctx, role),
    renderRecentArtifacts(ctx, 10),
    renderRoleMemory(ctx),
    renderLastProgressNotes(ctx, 5),
    renderBeatProcedure(ctx, role),
  ];
  const stateText = baseSections.join("\n\n---\n\n");

  const unifiedPrompt = task
    ? [
        renderIncomingHandoffsBanner(incomingHandoffs),
        renderTaskContext(task),
        renderWorkspaceContext(existingFiles),
        renderCompanyState(ctx),
        renderBudget(ctx),
        renderSprintHistory(ctx),
        renderOpenTasksForRole(ctx, role),
        renderRecentArtifacts(ctx, 10),
        renderRoleMemory(ctx),
        renderIncomingHandoffsSection(incomingHandoffs),
        renderLastProgressNotes(ctx, 5),
        renderUpstreamArtifacts(task),
      ].filter(Boolean).join("\n\n---\n\n")
    : null;

  return {
    ctx,
    stateText,
    openTaskCount: countOpenTasks(ctx, role),
    shownTasks: summarizeShownTasks(ctx, role),
    unifiedPrompt,
  };
}
