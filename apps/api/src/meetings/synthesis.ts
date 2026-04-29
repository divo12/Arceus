/**
 * Meeting Synthesis — Spec 18 Phase 4
 *
 * Two LLM-powered functions:
 *  1. buildContributionPrompt() — generates the prompt for an agent to produce
 *     a MeetingContribution during their beat
 *  2. synthesizeMeeting() — single LLM call that reads all contributions and
 *     detects conflicts, blockers, alignment issues, and highlights
 */

import { z } from "zod";
import { synthesisOutputSchema } from "@arceus/contracts";
import type { Meeting, CompanySnapshot, AgentIdentity } from "@arceus/contracts";
import { structuredCompletion, type LlmAuditContext } from "../infra/azure-openai.js";

// ── Contribution Prompt ────────────────────────────────────

const contributionResponseSchema = z.object({
  whatIDid: z.string(),
  whatImDoing: z.string(),
  blockers: z.string(),
  learnings: z.string(),
  questionsForTeam: z.string(),
});

/**
 * Build the system + user messages for an agent to produce their meeting contribution.
 * Called from the heartbeat's execute phase when the checklist detects a meeting_contribution need.
 */
export function buildContributionPrompt(
  meeting: Meeting,
  agent: { id: string; name: string; role: AgentIdentity["role"]; title: string },
  tasks: { id: string; title: string; status: string }[],
): { system: string; user: string } {
  const taskSummary = tasks.length > 0
    ? tasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")
    : "No tasks assigned.";

  const system = [
    `You are ${agent.name}, the ${agent.title} (role: ${agent.role}).`,
    `You are contributing to a ${meeting.type.replace(/_/g, " ")} meeting: "${meeting.title}".`,
    "Provide a concise status update for the team. Be honest about blockers.",
    "Keep each field to 1-2 sentences. Leave empty string if not applicable.",
  ].join("\n");

  const user = [
    "Your current tasks:",
    taskSummary,
    "",
    "Produce your meeting contribution with these fields:",
    "- whatIDid: What you completed since the last meeting",
    "- whatImDoing: What you are currently working on",
    "- blockers: Any blockers preventing progress (empty string if none)",
    "- learnings: Key learnings or insights to share (empty string if none)",
    "- questionsForTeam: Questions for other team members (empty string if none)",
  ].join("\n");

  return { system, user };
}

/**
 * Call the LLM to generate a meeting contribution for an agent.
 * Returns the contribution content (without agent metadata — caller wraps it).
 */
export async function generateContribution(
  meeting: Meeting,
  agent: { id: string; name: string; role: AgentIdentity["role"]; title: string },
  tasks: { id: string; title: string; status: string }[],
  auditCtx?: LlmAuditContext,
): Promise<z.infer<typeof contributionResponseSchema>> {
  const { system, user } = buildContributionPrompt(meeting, agent, tasks);

  return structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    contributionResponseSchema,
    "meeting_contribution",
    { temperature: 0.4 },
    auditCtx,
  );
}

// ── Synthesis ──────────────────────────────────────────────

/**
 * Synthesize all meeting contributions into a structured analysis.
 * Single LLM call (gpt-4o-mini) that detects conflicts, blockers,
 * alignment issues, and highlights.
 */
export async function synthesizeMeeting(
  meeting: Meeting,
  snap: CompanySnapshot,
  auditCtx?: LlmAuditContext,
): Promise<z.infer<typeof synthesisOutputSchema>> {
  if (meeting.contributions.length === 0) {
    return {
      conflicts: [],
      blockers: [],
      alignmentIssues: [],
      highlights: [],
      requiresBoardAttention: false,
      boardSummary: null,
    };
  }

  const contributionText = meeting.contributions
    .map((c) => [
      `## ${c.agentName} (${c.agentRole})`,
      `Done: ${c.contribution.whatIDid || "—"}`,
      `Doing: ${c.contribution.whatImDoing || "—"}`,
      `Blockers: ${c.contribution.blockers || "None"}`,
      `Learnings: ${c.contribution.learnings || "—"}`,
      `Questions: ${c.contribution.questionsForTeam || "—"}`,
    ].join("\n"))
    .join("\n\n");

  const sprintContext = snap.company.currentSprintId
    ? `Current sprint: #${snap.company.currentSprintNumber ?? "?"}, Goal: ${snap.strategy.summary}`
    : "No active sprint.";

  const system = [
    "You are a meeting facilitator AI analyzing team status updates.",
    "Identify conflicts (where agents are working at cross-purposes or duplicating effort),",
    "blockers (issues preventing progress), alignment issues, and highlights.",
    "Be concise. Only flag genuine issues — do not invent problems.",
    "Set requiresBoardAttention=true only for critical blockers or budget concerns.",
    "Generate unique IDs for conflicts, blockers, and alignment issues (e.g. 'conflict_1', 'blocker_1').",
  ].join("\n");

  const user = [
    `Meeting: ${meeting.type.replace(/_/g, " ")} — "${meeting.title}"`,
    `Company: ${snap.company.name}`,
    sprintContext,
    "",
    "## Team Contributions",
    contributionText,
    "",
    "Analyze these contributions and produce the synthesis output.",
  ].join("\n");

  return structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    synthesisOutputSchema,
    "meeting_synthesis",
    { temperature: 0.3 },
    auditCtx,
  );
}
