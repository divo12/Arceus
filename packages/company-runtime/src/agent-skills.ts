/**
 * Agent Skills Loader
 * 
 * Loads Contains Studio agent expertise files and maps them to Arceus roles.
 * Each role gets a composite skill injection from multiple specialist agents.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { RoleSoul } from "@arceus/contracts";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "agents");

/** Which Contains Studio agents feed into each Arceus role */
const ROLE_AGENT_MAP: Record<RoleSoul["role"], string[]> = {
  ceo: ["project-shipper", "trend-researcher", "studio-producer"],
  cto: ["backend-architect", "devops-automator", "ai-engineer"],
  pm: ["sprint-prioritizer", "feedback-synthesizer"],
  developer: ["frontend-developer", "rapid-prototyper", "backend-architect"],
  tester: ["test-writer-fixer", "test-results-analyzer", "api-tester"],
  ui_designer: ["ui-designer", "brand-guardian", "whimsy-injector", "ux-researcher"],
  marketing: ["content-creator", "growth-hacker", "app-store-optimizer"],
  skills_lead: ["workflow-optimizer", "tool-evaluator"],
};

/** Cache parsed agent system prompts (file content after YAML frontmatter) */
const cache = new Map<string, string>();

function extractSystemPrompt(raw: string): string {
  // Agent files have YAML frontmatter between --- markers, then the system prompt
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(raw);
  return match ? match[1].trim() : raw.trim();
}

function loadAgentPrompt(agentName: string): string | null {
  if (cache.has(agentName)) return cache.get(agentName)!;
  try {
    const raw = readFileSync(join(SKILLS_DIR, `${agentName}.md`), "utf-8");
    const prompt = extractSystemPrompt(raw);
    cache.set(agentName, prompt);
    return prompt;
  } catch {
    return null;
  }
}

/**
 * Get the composite agent skill injection for a role.
 * Returns a formatted string with expertise from all mapped agents,
 * ready to append to a system prompt.
 */
export function getAgentSkills(role: RoleSoul["role"]): string {
  const agentNames = ROLE_AGENT_MAP[role];
  if (!agentNames || agentNames.length === 0) return "";

  const sections: string[] = [];
  for (const name of agentNames) {
    const prompt = loadAgentPrompt(name);
    if (prompt) {
      // Take a meaningful excerpt — first ~1500 chars covers identity + responsibilities
      const excerpt = prompt.slice(0, 1500);
      const trimmed = excerpt.endsWith(".") ? excerpt : excerpt.slice(0, excerpt.lastIndexOf(".") + 1);
      sections.push(`## ${name} expertise\n${trimmed}`);
    }
  }

  if (sections.length === 0) return "";
  return "\n\n# Specialist Skills\n" + sections.join("\n\n");
}

/**
 * Get the full raw agent prompt for a specific Contains Studio agent.
 */
export function getFullAgentPrompt(agentName: string): string | null {
  return loadAgentPrompt(agentName);
}

/**
 * List all available agent names.
 */
export function listAvailableAgents(): string[] {
  return Object.values(ROLE_AGENT_MAP).flat();
}
