import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@arceus/contracts";
import { productDir } from "../orchestration/state.js";

export function buildSkillAuthoringArtifact(task: Task, output: string) {
  return [
    "# Skill Package Summary",
    `Task: ${task.title}`,
    `Deliverable: ${task.deliverable}`,
    "",
    "# Packaging Requirement",
    "This skill must be reusable by internal specialists and should capture a stable workflow, not one-off execution notes.",
    "",
    "# Skills Lead Report",
    output || "Skills Lead completed the skill-authoring task without additional notes.",
  ].join("\n");
}

export function slugifySkillName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "generated-skill";
}

export async function materializeSkillPackage(task: Task, output: string) {
  const slug = slugifySkillName(task.title.replace(/skill authoring|skill|package/gi, " "));
  const skillsRoot = join(productDir, ".arceus", "skills", slug);
  const skillFilePath = join(skillsRoot, "SKILL.md");
  const skillDocument = [
    `# ${task.title}`,
    "",
    "## Purpose",
    task.deliverable,
    "",
    "## Trigger",
    task.problemStatement,
    "",
    "## Definition Of Done",
    ...task.definitionOfDone.map((item) => `- ${item}`),
    "",
    "## Workflow",
    output || "Document the reusable workflow here.",
  ].join("\n");

  await mkdir(skillsRoot, { recursive: true });
  await writeFile(skillFilePath, `${skillDocument}\n`, "utf8");

  return {
    slug,
    relativePath: `.arceus/skills/${slug}/SKILL.md`,
  };
}
