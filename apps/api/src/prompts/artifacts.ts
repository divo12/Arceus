import type { Task } from "@arceus/contracts";
import { getPersistedArtifactById } from "../persistence/artifact-persistence.js";
import { getLocalPreviewState } from "../workspace/preview.js";

/**
 * Resolve incoming artifact content for a task.
 * Returns labelled sections for CTO plan, PM acceptance, and other upstream artifacts.
 */
export async function resolveIncomingArtifacts(companyId: string, task: Task): Promise<string[]> {
  const lines: string[] = [];
  if (task.incomingArtifactIds.length === 0) return lines;

  let budget = 6000;
  for (const artifactId of task.incomingArtifactIds) {
    if (budget <= 0) break;
    const artifact = await getPersistedArtifactById(companyId, artifactId);
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

