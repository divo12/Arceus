import type { AgentIdentity } from "@arceus/contracts";
import type { PreparedAgentContext } from "@arceus/hippocampus";
import { getSnapshot, updateAgentMemory } from "../persistence/store.js";
import { uniqueStrings } from "@arceus/task-engine";
import { getAgentByRole } from "@arceus/task-engine";

export function updateRoleMemory(role: AgentIdentity["role"], currentFocus: string[]) {
  const agent = getAgentByRole(getSnapshot(), role);
  if (!agent) return;

  updateAgentMemory(agent.id, (memory) => ({
    ...memory,
    currentFocus: uniqueStrings(currentFocus, 6),
    updatedAt: new Date().toISOString(),
  }));
}

export function enrichRoleMemory(
  role: AgentIdentity["role"],
  update: {
    currentFocus?: string[];
    recentLearnings?: string[];
    activePatterns?: string[];
    openBlockers?: string[];
    importantDecisions?: string[];
  },
) {
  const agent = getAgentByRole(getSnapshot(), role);
  if (!agent) return;

  updateAgentMemory(agent.id, (memory) => ({
    ...memory,
    currentFocus: update.currentFocus ? uniqueStrings([...update.currentFocus, ...memory.currentFocus], 6) : memory.currentFocus,
    recentLearnings: update.recentLearnings ? uniqueStrings([...update.recentLearnings, ...memory.recentLearnings], 8) : memory.recentLearnings,
    activePatterns: update.activePatterns ? uniqueStrings([...update.activePatterns, ...memory.activePatterns], 6) : memory.activePatterns,
    openBlockers: update.openBlockers ? uniqueStrings([...update.openBlockers, ...memory.openBlockers], 6) : memory.openBlockers,
    importantDecisions: update.importantDecisions ? uniqueStrings([...update.importantDecisions, ...memory.importantDecisions], 8) : memory.importantDecisions,
    updatedAt: new Date().toISOString(),
  }));
}

export function clearRoleBlockers(role: AgentIdentity["role"], blockersToClear: string[]) {
  const agent = getAgentByRole(getSnapshot(), role);
  if (!agent || blockersToClear.length === 0) return;

  const normalized = new Set(blockersToClear.map((item) => item.trim()));
  updateAgentMemory(agent.id, (memory) => ({
    ...memory,
    openBlockers: memory.openBlockers.filter((item) => !normalized.has(item.trim())),
    updatedAt: new Date().toISOString(),
  }));
}

export function formatHippocampusContext(ctx: PreparedAgentContext): string {
  const sections: string[] = [];

  if (ctx.memories.length > 0) {
    sections.push(
      "# Your Memory (facts you remember from previous work)",
      ...ctx.memories.map((m) => `- ${m.content}`),
    );
  }

  if (ctx.habits.length > 0) {
    sections.push(
      "",
      "# Your Habits (behavioral patterns you've learned)",
      ...ctx.habits.map((h) => `- When: ${h.trigger} → Do: ${h.action}`),
    );
  }

  if (ctx.priming) {
    sections.push("", `# Disposition: ${ctx.priming}`);
  }

  return sections.length > 0 ? sections.join("\n") : "";
}
