/**
 * buildBeatContext + renderStateForAgent — two separate concerns.
 *
 * - BeatContext: metadata the plugin + MCP server resolve against.
 * - renderStateForAgent: the prompt body the agent reasons over.
 *
 * Phase 6.5 — Package I.
 */
import type { BeatContext, TrustBand } from "@arceus/contracts";
import type { Role } from "../../../../.opencode/agent/config.js";
import { getAllowedArceusTools } from "../../../../.opencode/agent/config.js";
import { getSnapshot } from "../persistence/store.js";

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
