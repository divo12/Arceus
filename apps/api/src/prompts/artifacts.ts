import type { Task } from "@arceus/contracts";
import { artifacts, productDir } from "../orchestration/state.js";
import { getLocalPreviewState } from "../workspace/preview.js";

/**
 * Resolve incoming artifact content for a task.
 * Returns labelled sections for CTO plan, PM acceptance, and other upstream artifacts.
 */
export function resolveIncomingArtifacts(task: Task): string[] {
  const lines: string[] = [];
  if (task.incomingArtifactIds.length === 0) return lines;

  let budget = 6000;
  for (const artifactId of task.incomingArtifactIds) {
    if (budget <= 0) break;
    const artifact = artifacts.find((a) => a.id === artifactId);
    if (!artifact) continue;
    const snippet = artifact.content.slice(0, budget);
    const header = artifact.kind === "plan" ? "CTO Technical Plan"
      : artifact.kind === "specification" ? "PM Acceptance Criteria"
      : `Upstream Artifact: ${artifact.title}`;
    lines.push("", `# ${header}`, snippet);
    budget -= snippet.length;
  }
  return lines;
}

export function getPreviewEvidenceUrl() {
  const preview = getLocalPreviewState();
  return preview.validationUrl ?? preview.entryUrl ?? preview.url;
}

export function buildTesterArtifact(task: Task, output: string) {
  const preview = getLocalPreviewState();
  const evidenceUrl = getPreviewEvidenceUrl();

  return [
    "# Verification Summary",
    `Task: ${task.title}`,
    `Kind: ${task.kind}`,
    `Target kind: ${preview.targetKind ?? "unknown"}`,
    `Validation URL: ${evidenceUrl ?? "not available"}`,
    `Validation strategy: ${preview.validationStrategy ?? "not available"}`,
    `Runtime: ${preview.runtime ?? "unknown"}`,
    `Framework: ${preview.framework ?? "unknown"}`,
    `Preview status: ${preview.status}`,
    "",
    "# Definition Of Done Checklist",
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    "# Tester Report",
    output || "Tester completed the verification task without additional notes.",
  ].join("\n");
}

export function buildDesignDirectionArtifact(task: Task, output: string) {
  const preview = getLocalPreviewState();

  return [
    "# Design Direction Summary",
    `Task: ${task.title}`,
    `Target kind: ${preview.targetKind ?? "unknown"}`,
    `Preview entry URL: ${preview.entryUrl ?? preview.url ?? "not available"}`,
    `Validation URL: ${preview.validationUrl ?? "not available"}`,
    "",
    "# Downstream Expectations",
    "Developer should use this to sharpen implementation details and interaction choices.",
    "Tester should use this to focus verification on UX clarity, interaction consistency, and visible quality risks.",
    "",
    "# UI Designer Report",
    output || "UI Designer completed the design-direction task without additional notes.",
  ].join("\n");
}

export function buildMarketingArtifact(task: Task, output: string) {
  const preview = getLocalPreviewState();

  return [
    "# Launch Readiness Report",
    `Task: ${task.title}`,
    `Kind: ${task.kind}`,
    `Target kind: ${preview.targetKind ?? "unknown"}`,
    `Preview evidence URL: ${getPreviewEvidenceUrl() ?? "not available"}`,
    `Preview status: ${preview.status}`,
    "",
    "# Governance Boundary",
    task.kind === "distribution_campaign"
      ? "This report may recommend outbound actions, but no email, post, ad, or other external distribution was executed automatically. Board approval is required before any external action is taken."
      : "This report is internal launch preparation content. No external action was executed automatically.",
    "",
    "# Marketing Report",
    output || "Marketing completed the launch-readiness task without additional notes.",
  ].join("\n");
}
