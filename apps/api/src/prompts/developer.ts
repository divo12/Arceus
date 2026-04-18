import type { Task } from "@arceus/contracts";
import { productDir } from "../orchestration/state.js";
import { getLocalPreviewState } from "../workspace/preview.js";
import { resolveIncomingArtifacts } from "./artifacts.js";

/**
 * Build a prompt for developer beats that instructs the agent to actually write code.
 * Unlike buildSpecialistTaskPrompt (text-only), this enables tool use.
 */
export function buildDeveloperBeatPrompt(task: Task, existingFiles?: string[]) {
  const preview = getLocalPreviewState();
  const lines = [
    `# Task`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Problem statement: ${task.problemStatement}`,
    `Deliverable: ${task.deliverable}`,
    `Definition of done:`,
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    `# Workspace`,
    `Product directory: ${productDir}`,
    `All code MUST be written inside ${productDir}. Do NOT modify files outside this directory.`,
    `Current preview: ${preview.status === "ready" ? (preview.url ?? "running") : "not running"}`,
  ];

  if (existingFiles && existingFiles.length > 0) {
    lines.push("", `# Existing files in workspace (${existingFiles.length} files)`);
    const shown = existingFiles.slice(0, 100);
    for (const f of shown) {
      lines.push(`- ${f}`);
    }
    if (existingFiles.length > 100) {
      lines.push(`... and ${existingFiles.length - 100} more`);
    }
  } else {
    lines.push("", `# Existing files in workspace`, `No files found — this is a fresh workspace. The project will be auto-scaffolded.`);
  }

  lines.push(
    "",
    `# Instructions`,
    `You are a software developer. IMPLEMENT this task by writing real code using your tools.`,
    `The workspace is pre-configured with: Vite + React 18 + TypeScript + Tailwind CSS 3 + shadcn/ui utilities.`,
    `Design tokens and a style guide are in design/style-guide.md — follow them.`,
    `The cn() utility is at src/lib/utils.ts — use it for conditional class merging.`,
    `1. Read existing files in the workspace to understand the current codebase.`,
    `2. Write or edit files to implement the task requirements.`,
    `3. Create components as separate files in src/components/ — NOT everything in App.tsx.`,
    `4. Do NOT run npm create vite, do NOT reconfigure Tailwind — it's already set up.`,
    `5. Do NOT start a dev server — preview is handled separately.`,
    `6. After writing code, briefly summarize what you implemented.`,
  );

  const upstreamContext = resolveIncomingArtifacts(task);
  if (upstreamContext.length > 0) {
    lines.push(...upstreamContext);
  }

  return lines.join("\n");
}
