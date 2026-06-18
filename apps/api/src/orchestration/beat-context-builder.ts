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
import * as boardMessagesRepo from "@arceus/db/src/repos/board_messages.js";
import { buildBoardDirectivesBlock } from "../agents/board-directives.js";
import { renderHeartbeat } from "./task-heartbeat.js";
import { dedupeAssembled } from "./prompt-dedup.js";
import { getRoleSoul } from "@arceus/company-runtime";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as memorySummariesRepo from "@arceus/db/src/repos/memory_summaries.js";
import * as memoryUnitsRepo from "@arceus/db/src/repos/memory_units.js";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { selectMemoriesToRetain } from "@arceus/hippocampus";
import type { Role } from "../../../../.opencode/agent/config.js";
import { getAllowedArceusTools } from "../../../../.opencode/agent/config.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import {
  walkWorkspaceManifest,
  formatSize,
  formatRelativeTime,
  type WorkspaceManifestEntry,
} from "../workspace/manifest.js";
import { resolveIncomingArtifacts } from "../prompts/artifacts.js";
import { getProductDir } from "./state.js";
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

/**
 * Statuses the DB `claimTask` CAS will actually accept on a fresh
 * claim attempt. Kept in sync with `claimableStatuses` in
 * packages/db/src/repos/tasks/claim.ts. Used by the renderer to
 * label tasks as ✅ claimable vs ⛔ not-yet-claimable so the agent's
 * `task_claim` call has matching expectations.
 *
 * Note: `blocked` is included because the re-claim policy added in
 * 5bc3011 lets an agent re-claim its own blocked task to retry the
 * work. The label in renderOpenTasksForRole surfaces the prior
 * block reason via the "🔁 Previously blocked" line so the agent
 * decides between re-claim and idle.
 */
const DB_CLAIMABLE_STATUSES: readonly Task["status"][] = [
  "created",
  "planned",
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

/** Compact board-message slice — what the directives renderer needs. */
interface BeatBoardMessageSlice {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface BeatRenderContext {
  company: Company | null;
  agents: readonly BeatAgentSlice[];
  sprints: Sprint[];
  tasks: Task[];
  /** Recent board/CEO chat — the directives renderer distills standing board
   * instructions from the `board`-role messages here. */
  boardMessages: readonly BeatBoardMessageSlice[];
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
 * Over-fetch pool for value-ranked retention. We pull up to this many of the
 * agent's memories, then keep the MAX_AGENT_MEMORY_UNITS most VALUABLE (durable
 * decisions over transient notes) rather than just the newest — so a standing
 * decision isn't silently evicted by a burst of recent progress notes.
 */
const AGENT_MEMORY_RETENTION_POOL = 300;
/** Board-owner messages scanned for standing directives. Board chat is sparse,
 * so a high cap effectively covers the whole history — directives never age out. */
const DURABLE_BOARD_DIRECTIVE_LIMIT = 300;

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
  const [company, agentRows, sprintRows, tasks, artifactRows, summaries, boardRows] = await Promise.all([
    companiesRepo.findByIdHydrated(db, companyId),
    agentsRepo.listAgentsByCompany(db, companyId),
    sprintsRepo.listSprintsByCompany(db, companyId),
    tasksRepo.listByCompanyHydrated(db, companyId),
    artifactsRepo.listArtifactsByCompany(db, companyId, RECENT_ARTIFACT_LIMIT),
    memorySummariesRepo.listByCompany(db, companyId),
    boardMessagesRepo.listBoardRoleMessages(db, companyId, DURABLE_BOARD_DIRECTIVE_LIMIT),
  ]);
  const boardMessages: BeatBoardMessageSlice[] = boardRows.map((row) => {
    const m = boardMessagesRepo.rowToChatMessage(row);
    return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt };
  });

  const agents: BeatAgentSlice[] = agentRows.map((row) => ({
    id: row.id,
    role: parseRoleStrict(row.role),
    displayName: row.displayName,
  }));
  const sprints = sprintRows.map(sprintsRepo.rowToSprint);
  const artifacts = artifactRows.map(artifactsRepo.rowToArtifact);
  const memorySummaries = summaries.map(memorySummariesRepo.rowToSummary);

  const roleAgent = agents.find((a) => a.role === role) ?? null;
  const memoryPool = roleAgent
    ? await memoryUnitsRepo.listMemoryUnitsByAgent(db, roleAgent.id, undefined, AGENT_MEMORY_RETENTION_POOL)
    : null;
  // Keep the most valuable memories within budget (durable decisions survive a
  // burst of recent low-value notes), newest-first for the render slices below.
  const memoryUnitRows = memoryPool
    ? selectMemoriesToRetain(memoryPool, MAX_AGENT_MEMORY_UNITS)
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

  return { company, agents, sprints, tasks, artifacts, memorySummaries, roleMemoryUnits, roleAgent, boardMessages };
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

export function renderCompanyState(ctx: BeatRenderContext): string {
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
  // Component 3: fan the board's standing directives (+ any conflicts) out to
  // EVERY role's beat — they are implementation constraints (e.g. "always use a
  // dark theme", "checkout must work on mobile"), not just CEO planning context.
  const directives = buildBoardDirectivesBlock(ctx.boardMessages ?? []);
  if (directives) lines.push("", directives);
  return lines.join("\n");
}

/**
 * Count of role-assigned tasks in workable states. Used by `runBeat`
 * to skip the prompt entirely when an agent has nothing to do
 * (avoids filler-work hallucination from a bored LLM).
 */
function countOpenTasks(ctx: BeatRenderContext, role: Role): number {
  return ctx.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  ).length;
}

/**
 * Soft-dep policy (concurrency-friendly).
 *
 * Pre-concurrency, a task was claimable only if every depended-on task
 * was `completed` or `verified`. That's correct for hard-handoff edges
 * (e.g. CTO architecture must finalize before developer codes), but
 * unnecessarily strict for spec-style edges where the depended-on task
 * has already produced a usable artifact mid-flight (PM ships a spec
 * draft → designer can start interpreting it; doesn't have to wait for
 * PM to formally `task_complete`).
 *
 * Rule: a dep is satisfied if the dep is in a terminal state OR the
 * dep has produced at least one attached artifact. This is materially
 * looser than "completed only" but the artifact gate keeps the implicit
 * contract — work cannot start before there is something to read.
 *
 * If the dep later changes its artifact (revision), the dependent's
 * `incomingArtifactIds` is updated by the early-promotion hook in the
 * artifact_create route, so the dependent always sees the latest spec
 * on its next `task_get`.
 *
 * If the dep is BLOCKED, the dep is treated as still-unmet — a blocked
 * task is escalating, not progressing, and downstream work would be
 * rebuilding on a contested foundation. Escalation must resolve first.
 */
function isDepSatisfied(dep: BeatRenderContext["tasks"][number] | undefined): boolean {
  if (!dep) return false;
  if (dep.status === "blocked" || dep.status === "failed" || dep.status === "cancelled") return false;
  if ((["completed", "verified"] as string[]).includes(dep.status)) return true;
  // Soft-met: dep is in flight but has produced at least one artifact.
  return (dep.artifactIds?.length ?? 0) > 0;
}

/** Snapshot of what the role sees in `## Your Tasks` (for diagnostic events). */
function summarizeShownTasks(
  ctx: BeatRenderContext,
  role: Role,
): { id: string; title: string; status: string; claimable: boolean }[] {
  return ctx.tasks
    .filter((t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status))
    .map((t) => {
      const depsUnmet = (t.dependsOnTaskIds ?? []).some((depId) => {
        const dep = ctx.tasks.find((d) => d.id === depId);
        return !isDepSatisfied(dep);
      });
      const claimable = DB_CLAIMABLE_STATUSES.includes(t.status) && !depsUnmet;
      return { id: t.id, title: t.title, status: t.status, claimable };
    });
}

export function renderOpenTasksForRole(ctx: BeatRenderContext, role: Role): string {
  const tasks = ctx.tasks.filter(
    (t) => t.assignedRole === role && OPEN_TASK_STATUSES.includes(t.status),
  );
  if (tasks.length === 0) return "## Your Tasks\n\n_No open tasks._";
  const lines = ["## Your Tasks", ""];
  for (const t of tasks) {
    const unmetDeps = (t.dependsOnTaskIds ?? [])
      .map((depId) => ctx.tasks.find((d) => d.id === depId))
      .filter((d): d is NonNullable<typeof d> => !!d && !isDepSatisfied(d));
    // Soft-dep marker: a dep that's in_progress with attached artifacts
    // counts as claimable but is worth flagging so the agent knows the
    // upstream may still iterate. Pure-terminal deps get the cleaner
    // "✅ claimable" label.
    const softDeps = (t.dependsOnTaskIds ?? [])
      .map((depId) => ctx.tasks.find((d) => d.id === depId))
      .filter((d): d is NonNullable<typeof d> =>
        !!d
        && !(["completed", "verified"] as string[]).includes(d.status)
        && (d.artifactIds?.length ?? 0) > 0,
      );
    let readiness: string;
    if (unmetDeps.length > 0) {
      readiness = ` ⛔ NOT CLAIMABLE — waiting on: ${unmetDeps.map((d) => `"${d.title}" [${d.status}]`).join(", ")}`;
    } else if (softDeps.length > 0) {
      readiness = ` 🟡 claimable (draft artifact available — upstream still in progress: ${softDeps.map((d) => `"${d.title}"`).join(", ")})`;
    } else {
      readiness = " ✅ claimable";
    }
    lines.push(`- [${t.status}] **${t.title}** (${t.id})${readiness}`);
    if (t.description) lines.push(`  ${t.description}`);
    // For previously-blocked tasks, surface the prior block reason
    // so the agent can decide between (a) retry-claim with a real fix,
    // or (b) leave it blocked and report idle. Without this, the agent
    // sees `[blocked]` but has no hint why — and tends to either ignore
    // it or hallucinate a new reason.
    if (t.status === "blocked" && t.verifierState?.feedback) {
      const reason = t.verifierState.feedback;
      lines.push(`  🔁 Previously blocked: "${reason}" — re-claim to retry.`);
    }
    // Heartbeat: the agent's living Done/Doing/Next/Blocked checklist, rewritten
    // at beat end and read here on claim, so a multi-beat or blocked task resumes
    // instead of restarting amnesiac. Rendered for ANY open task that has one: a
    // reaped beat's claim is released back to `planned`, and this is exactly what
    // the next claimant needs.
    const heartbeatMd = t.heartbeat ? renderHeartbeat(t.heartbeat) : "";
    if (heartbeatMd) {
      lines.push("  Heartbeat (your running checklist — update it before ending the beat):");
      for (const hbLine of heartbeatMd.split("\n")) {
        lines.push(`    ${hbLine}`);
      }
      lines.push("  Continue from where this leaves off — do NOT redo Done items.");
    }
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

export function renderRoleMemory(ctx: BeatRenderContext): string {
  if (!ctx.roleAgent) return "## Role Memory\n\n_No agent found._";
  const mem = ctx.memorySummaries.find((m) => m.agentId === ctx.roleAgent!.id);
  if (!mem) return "## Role Memory\n\n_No memory entries._";
  // Continuity (Focus/Blockers) now lives in the per-task heartbeat — Role Memory
  // carries only role-level KNOWLEDGE that outlives any single task.
  const lines = ["## Role Memory", ""];
  if (mem.recentLearnings.length > 0) {
    lines.push("**Learnings:** " + mem.recentLearnings.join("; "));
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

async function renderUpstreamArtifacts(companyId: string, task: Task): Promise<string> {
  const upstreamLines = await resolveIncomingArtifacts(companyId, task);
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

function renderWorkspaceContext(
  companyId: string,
  manifest?: WorkspaceManifestEntry[],
): string {
  const preview = getLocalPreviewState(companyId);
  const lines = [
    "## Workspace",
    `- **Product directory:** ${getProductDir(companyId)} (referenced as \`/workspace\` in tools — plugin handles tenant routing)`,
    `- **Preview status:** ${preview.status}`,
  ];
  if (preview.url) lines.push(`- **Preview URL:** ${preview.url}`);
  if (preview.entryUrl) lines.push(`- **Entry URL:** ${preview.entryUrl}`);
  if (preview.validationUrl) lines.push(`- **Validation URL:** ${preview.validationUrl}`);
  if (preview.validationStrategy) lines.push(`- **Validation strategy:** ${preview.validationStrategy}`);
  if (preview.targetKind) lines.push(`- **Target kind:** ${preview.targetKind}`);
  if (preview.runtime) lines.push(`- **Runtime:** ${preview.runtime}`);
  if (preview.framework) lines.push(`- **Framework:** ${preview.framework}`);

  if (manifest && manifest.length > 0) {
    const shown = manifest.slice(0, 120);
    const truncated = manifest.length > shown.length;
    lines.push(
      "",
      `### Workspace files (${manifest.length})`,
      truncated
        ? `Newest ${shown.length} files shown (older ones omitted). Prefer these paths; glob only for files older than the oldest entry below.`
        : `This listing is COMPLETE (node_modules/.git/dist excluded). If a file is not listed here, it does not exist — do NOT glob or list directories to double-check. Go straight to read/edit with these paths.`,
      "",
    );
    for (const e of shown) {
      lines.push(`- \`/workspace/${e.path}\`  (${formatSize(e.size)}, ${formatRelativeTime(e.modifiedAt)})`);
    }
  } else {
    lines.push(
      "",
      `### Workspace files`,
      `_The workspace is EMPTY (no files yet). Do not glob or grep — there is nothing to find. Your edits will create the first files._`,
    );
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
  const blockedTasks = myTasks.filter((t) => t.status === "blocked");
  const claimable = myTasks.filter((t) => {
    if (!DB_CLAIMABLE_STATUSES.includes(t.status)) return false;
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

  const lines: string[] = ["## How to work this beat — Task Lifecycle Contract", ""];

  if (blockedTasks.length > 0) {
    lines.push(
      `You have ${blockedTasks.length} blocked task(s) marked 🚫 in \`## Your Tasks\`.`,
      "Blocked tasks CANNOT be claimed — do NOT call `task_claim` on them.",
      "The system will automatically create a follow-up task to resolve the blocker. Wait for it to appear in your task list.",
      "",
    );
  }

  if (claimable.length === 0) {
    lines.push(
      "You have open tasks but **none are directly claimable** right now:",
      "- 🚫 BLOCKED tasks: call `task_resolve_blocker` (see above).",
      "- ⛔ NOT CLAIMABLE tasks: waiting on upstream dependencies — end your turn and wait.",
      "Do not call `task_claim`. Do not invent work.",
    );
    return lines.join("\n");
  }

  lines.push(
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
  );
  return lines.join("\n");
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
async function renderStateForAgent(role: Role, companyId: string): Promise<string> {
  const ctx = await loadBeatRenderContext(companyId, role);
  const sections = [
    renderCompanyState(ctx),
    renderOpenTasksForRole(ctx, role),
    renderRecentArtifacts(ctx, 10),
    renderRoleMemory(ctx),
    renderLastProgressNotes(ctx, 5),
    renderBeatProcedure(ctx, role),
  ];
  // Collapse instructions the role soul (sent separately as the system message)
  // already states, so the assembled user prompt doesn't repeat them.
  return dedupeAssembled(sections, getRoleSoul(role)?.systemPrompt ?? "");
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
  _existingFiles?: string[],  // deprecated: superseded by manifest walker below
): Promise<{
  ctx: BeatRenderContext;
  stateText: string;
  openTaskCount: number;
  shownTasks: ReturnType<typeof summarizeShownTasks>;
  unifiedPrompt: string | null;
}> {
  const ctx = await loadBeatRenderContext(companyId, role);
  const incomingHandoffs = drainIncomingHandoffs(ctx);

  // Walk the workspace once and reuse for both render paths. The walker
  // filters out the scaffold seed (skill(developer-workspace-layout)
  // already documents it) plus runtime noise (node_modules, .git,
  // dist, .opencode). So this manifest is "what beats produced or
  // imported into the workspace beyond the seed" — exactly what the
  // model needs to skip its glob-discovery phase.
  const productDir = getProductDir(companyId);
  // 120 entries, seed files included: the listing must be COMPLETE to be
  // trusted. At 40-with-seed-filtered, the model treated the manifest as
  // a hint and re-verified with glob storms (36 globs/beat observed).
  const manifest = await walkWorkspaceManifest(productDir, { maxDepth: 4, maxEntries: 120 });

  const baseSections = [
    renderCompanyState(ctx),
    renderWorkspaceContext(companyId, manifest),
    renderOpenTasksForRole(ctx, role),
    renderRecentArtifacts(ctx, 10),
    renderRoleMemory(ctx),
    renderLastProgressNotes(ctx, 5),
    renderBeatProcedure(ctx, role),
  ];
  // De-dup against the role soul (sent separately as the system message) so the
  // user prompt doesn't restate what the soul already says, or repeat a sentence
  // across its own sections.
  const soulText = getRoleSoul(role)?.systemPrompt ?? "";
  const stateText = dedupeAssembled(baseSections, soulText);

  const unifiedPrompt = task
    ? dedupeAssembled(
        [
          renderIncomingHandoffsBanner(incomingHandoffs),
          renderTaskContext(task),
          renderWorkspaceContext(companyId, manifest),
          renderCompanyState(ctx),
          renderBudget(ctx),
          renderSprintHistory(ctx),
          renderOpenTasksForRole(ctx, role),
          renderRecentArtifacts(ctx, 10),
          renderRoleMemory(ctx),
          renderIncomingHandoffsSection(incomingHandoffs),
          renderLastProgressNotes(ctx, 5),
          await renderUpstreamArtifacts(companyId, task),
        ].filter(Boolean),
        soulText,
      )
    : null;

  return {
    ctx,
    stateText,
    openTaskCount: countOpenTasks(ctx, role),
    shownTasks: summarizeShownTasks(ctx, role),
    unifiedPrompt,
  };
}
