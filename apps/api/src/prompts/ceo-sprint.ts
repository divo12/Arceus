/**
 * CEO Sprint Planning Context — builds a fact-dense context prompt so the
 * CEO agent can reason about what to build next and call sprint_create.
 *
 * This is context injection, NOT reasoning instructions. The CEO's soul
 * prompt defines personality and decision-making style.
 */
import type { CompanySnapshot, Task, Sprint } from "@arceus/contracts";

// ── Helpers ──────────────────────────────────────────────

function summariseSprint(sprint: Sprint, tasks: Task[]): string {
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");
  const cancelled = tasks.filter((t) => t.status === "cancelled");
  const blocked = tasks.filter((t) => t.status === "blocked");

  const lines = [
    `### Sprint ${sprint.number}: "${sprint.goal}"`,
    `Status: ${sprint.status} | ${completed.length} completed, ${failed.length} failed, ${cancelled.length} cancelled, ${blocked.length} blocked`,
  ];

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

  return lines.join("\n");
}

const ROLES_AND_CAPABILITIES = [
  "- **cto**: Technical architecture, code review, build verification, escalation decisions",
  "- **pm**: Product specs, acceptance criteria, scope control, delivery tracking",
  "- **developer**: Implementation — writes code, builds features, fixes bugs",
  "- **tester**: QA verification, bug reporting, acceptance testing",
  "- **ui_designer**: UI/UX design, visual assets, design system",
  "- **marketing**: Content, positioning, launch materials",
  "- **skills_lead**: Agent skill management, pattern analysis",
].join("\n");

// ── Public API ───────────────────────────────────────────

/**
 * Build a context-rich prompt for the CEO agent's sprint planning beat.
 * Provides facts about the world — the CEO reasons about what to do.
 */
export function buildCeoSprintPlanningPrompt(task: Task, snapshot: CompanySnapshot): string {
  const sections: string[] = [];

  // ── Task assignment ──
  sections.push(`# Your Task\n${task.title}\n${task.description}`);

  // ── Company state ──
  const budgetPct = snapshot.company.budgetCents > 0
    ? ((snapshot.company.spentCents / snapshot.company.budgetCents) * 100).toFixed(0)
    : "0";
  sections.push([
    "# Company State",
    `Goal: ${snapshot.company.goal || "(not set)"}`,
    `Strategy: ${snapshot.strategy?.status ?? "none"}`,
    `Budget: ${budgetPct}% used (${snapshot.company.spentCents}¢ of ${snapshot.company.budgetCents}¢)`,
    `Current sprint number: ${snapshot.company.currentSprintNumber ?? 0}`,
  ].join("\n"));

  // ── Team ──
  sections.push(`# Available Team\n${ROLES_AND_CAPABILITIES}`);

  // ── Previous sprints (last 3) ──
  const completedSprints = snapshot.sprints
    .filter((s) => s.status === "completed")
    .sort((a, b) => b.number - a.number)
    .slice(0, 3);

  if (completedSprints.length > 0) {
    const sprintSummaries = completedSprints.map((s) => {
      const sprintTasks = snapshot.tasks.filter((t) => t.sprintId === s.id);
      return summariseSprint(s, sprintTasks);
    });
    sections.push(`# Previous Sprint Results\n${sprintSummaries.join("\n\n")}`);
  } else {
    sections.push("# Previous Sprint Results\nThis is the first sprint — no prior history.");
  }

  // ── Carried-forward items (failed/blocked tasks from last sprint) ──
  const lastSprint = completedSprints[0];
  if (lastSprint) {
    const carryForward = snapshot.tasks.filter(
      (t) => t.sprintId === lastSprint.id && ["failed", "blocked"].includes(t.status),
    );
    if (carryForward.length > 0) {
      const items = carryForward.map((t) => `- ${t.title} (${t.assignedRole}, was ${t.status})`);
      sections.push(`# Carried-Forward Items\nThese tasks from Sprint ${lastSprint.number} did not complete:\n${items.join("\n")}`);
    }
  }

  // ── Stale in-progress tasks ──
  const staleThreshold = Date.now() - 10 * 60 * 1000;
  const staleTasks = snapshot.tasks.filter(
    (t) => t.status === "in_progress" &&
      new Date(t.startedAt ?? t.createdAt ?? new Date().toISOString()).getTime() < staleThreshold,
  );
  if (staleTasks.length > 0) {
    const items = staleTasks.map((t) => `- ${t.title} (${t.assignedRole}, in_progress >10min)`);
    sections.push(`# Stale Tasks\n${items.join("\n")}`);
  }

  // ── Available tool ──
  sections.push([
    "# Tool",
    "Call `sprint_create` with:",
    "- `goal`: what this sprint delivers",
    "- `tasks`: array of { title, assigned_role, priority, depends_on, description }",
    "",
    "Dependencies use task titles (exact match). Tasks with no dependencies start immediately.",
  ].join("\n"));

  return sections.join("\n\n");
}
