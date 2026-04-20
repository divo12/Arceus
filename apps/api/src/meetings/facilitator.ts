/**
 * Facilitator Agent — Spec 24 Phase 4b
 *
 * Replaces the separate synthesizeMeeting() + resolveMeeting() + buildDailySyncBrief()
 * LLM calls with a single Facilitator Agent session (3 multi-turn phases).
 *
 * Phase 1 — SYNTHESIZE: Detect conflicts, blockers, alignment issues, highlights
 * Phase 2 — RESOLVE: Decide actions for each conflict/blocker
 * Phase 3 — BRIEF: Generate daily sync brief (daily_sync meetings only)
 */

import { z } from "zod";
import { synthesisOutputSchema, resolutionOutputSchema, dailySyncBriefSchema } from "@arceus/contracts";
import type { Meeting, CompanySnapshot, SynthesisOutput, ResolutionOutput, DailySyncBrief } from "@arceus/contracts";
import { runInternalAgentPrompt } from "../prompts/internal-agent.js";

// ── Helpers ────────────────────────────────────────────────

function formatContributions(meeting: Meeting): string {
  if (meeting.contributions.length === 0) return "No contributions.";
  return meeting.contributions
    .map((c) => [
      `## ${c.agentName} (${c.agentRole})`,
      `Done: ${c.contribution.whatIDid || "—"}`,
      `Doing: ${c.contribution.whatImDoing || "—"}`,
      `Blockers: ${c.contribution.blockers || "None"}`,
      `Learnings: ${c.contribution.learnings || "—"}`,
      `Questions: ${c.contribution.questionsForTeam || "—"}`,
    ].join("\n"))
    .join("\n\n");
}

function extractJson(output: string): string | null {
  const match = output.match(/\{[\s\S]*\}/);
  return match?.[0] ?? null;
}

// ── Facilitator Session ────────────────────────────────────

export interface FacilitatorResult {
  synthesis: SynthesisOutput;
  resolutions: ResolutionOutput;
  brief: DailySyncBrief | null;
}

/**
 * Run the full Facilitator Agent session for a meeting.
 * Multi-turn: Synthesize → Resolve → Brief (3 turns in one session).
 */
export async function runFacilitatorSession(
  meeting: Meeting,
  snap: CompanySnapshot,
): Promise<FacilitatorResult> {
  const sprintContext = snap.company.currentSprintId
    ? `Current sprint: #${snap.company.currentSprintNumber ?? "?"}, Goal: ${snap.strategy.summary}`
    : "No active sprint.";

  const contributionText = formatContributions(meeting);

  // ── Phase 1: SYNTHESIZE ──────────────────────────────────

  const synthesizePrompt = [
    "Phase 1 — SYNTHESIZE. Analyze these meeting contributions and produce a synthesis.",
    "Respond with JSON matching: { conflicts: [{id, description, involvedAgentIds, severity, suggestedResolution}], blockers: [{id, description, reportedByAgentId, suggestedAction}], alignmentIssues: [{id, description}], highlights: [{id, description, agentId}], requiresBoardAttention: boolean, boardSummary: string|null }",
    "",
    `Meeting: ${meeting.type.replace(/_/g, " ")} — "${meeting.title}"`,
    `Company: ${snap.company.name}`,
    sprintContext,
    "",
    "## Team Contributions",
    contributionText,
  ].join("\n");

  const synthesisOutput = await runInternalAgentPrompt("facilitator_agent", null, synthesizePrompt);
  let synthesis: SynthesisOutput;
  try {
    const json = extractJson(synthesisOutput);
    if (!json) throw new Error("No JSON in synthesis output");
    synthesis = synthesisOutputSchema.parse(JSON.parse(json));
  } catch {
    synthesis = { conflicts: [], blockers: [], alignmentIssues: [], highlights: [], requiresBoardAttention: false, boardSummary: null };
  }

  // ── Phase 2: RESOLVE ─────────────────────────────────────

  const issueCount = synthesis.conflicts.length + synthesis.blockers.length;
  let resolutions: ResolutionOutput = { decisions: [] };

  if (issueCount > 0) {
    const conflictText = synthesis.conflicts
      .map((c) => `- [${c.id}] (${c.severity}) ${c.description}\n  Agents: ${c.involvedAgentIds.join(", ")}\n  Suggested: ${c.suggestedResolution}`)
      .join("\n") || "None.";

    const blockerText = synthesis.blockers
      .map((b) => `- [${b.id}] ${b.description}\n  Reported by: ${b.reportedByAgentId}\n  Suggested: ${b.suggestedAction}`)
      .join("\n") || "None.";

    const currentTasks = snap.tasks
      .filter((t) => t.status !== "completed" && t.status !== "cancelled")
      .slice(0, 20)
      .map((t) => `- [${t.id}] [${t.status}] ${t.title} (${t.assignedRole})`)
      .join("\n") || "No active tasks.";

    const resolvePrompt = [
      "Phase 2 — RESOLVE. For each conflict and blocker you just identified, decide an action.",
      "Respond with JSON matching: { decisions: [{decision, action, conflictId, blockerId, taskAction, escalation}] }",
      "Actions: create_task, modify_task, escalate_to_board, note, no_action.",
      "",
      "## Conflicts",
      conflictText,
      "",
      "## Blockers",
      blockerText,
      "",
      "## Current Tasks (for reference when modifying)",
      currentTasks,
    ].join("\n");

    const resolveOutput = await runInternalAgentPrompt("facilitator_agent", null, resolvePrompt);
    try {
      const json = extractJson(resolveOutput);
      if (json) resolutions = resolutionOutputSchema.parse(JSON.parse(json));
    } catch {
      // Keep empty resolutions on parse failure
    }
  }

  // ── Phase 3: BRIEF (daily_sync only) ─────────────────────

  let brief: DailySyncBrief | null = null;

  if (meeting.type === "daily_sync") {
    const decisionSummary = resolutions.decisions
      .filter((d) => d.action !== "no_action" && d.action !== "note")
      .map((d) => `- [${d.action}] ${d.decision}`)
      .join("\n") || "No decisions.";

    const briefPrompt = [
      "Phase 3 — BRIEF. Generate a concise daily sync brief summarizing company status.",
      "Respond with JSON matching: { date, companyStatus, teamUpdates: [{agentRole, summary}], activeBlockers: [string], upcomingDependencies: [string], decisionsFromMeeting: [string] }",
      "",
      `Company: ${snap.company.name}`,
      `Sprint: #${snap.company.currentSprintNumber ?? "none"}`,
      "",
      "## Decisions Made",
      decisionSummary,
    ].join("\n");

    const briefOutput = await runInternalAgentPrompt("facilitator_agent", null, briefPrompt);
    try {
      const json = extractJson(briefOutput);
      if (json) brief = dailySyncBriefSchema.parse(JSON.parse(json));
    } catch {
      // No brief on parse failure
    }
  }

  return { synthesis, resolutions, brief };
}
