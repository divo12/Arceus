/**
 * CTO Task Planning Prompt — Spec 24 Phase 2b
 *
 * Extracted from planner.ts inline prompt. Used when routing the
 * task plan generation through the CTO's existing agent session.
 */

import type { CompanySnapshot } from "@arceus/contracts";
import { plannerConfig } from "../config/index.js";

/** Build the CTO task planning prompt from the current company snapshot. */
export function buildCtoPlanPrompt(snapshot: CompanySnapshot): string {
  const roster = snapshot.agents.map((agent) => agent.role);
  const availableRolesLine = roster.length > 0
    ? roster.join(", ")
    : (plannerConfig.followUpAssignedRoles as readonly string[]).join(", ");

  return [
    `Company: ${snapshot.company.name}`,
    `Goal: ${snapshot.company.goal}`,
    `First release: ${snapshot.strategy.firstRelease}`,
    `Strategy summary: ${snapshot.strategy.summary}`,
    `Scope boundaries: ${snapshot.strategy.scopeBoundary.join("; ")}`,
    `Current workspace: ${snapshot.company.name ? "Available at repo-root /workspace" : "Not yet created"}`,
    `Available roles: ${availableRolesLine}`,
    `Hard constraint: every task's assigned_role MUST be one of the Available roles above. Tasks for roles not listed will be rejected by validation.`,
    "",
    ...plannerConfig.prompts.userInstructions,
    "",
    "Respond with ONLY valid JSON matching the task plan schema. No markdown, no explanation.",
  ].join("\n");
}
