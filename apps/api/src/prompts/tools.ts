import type { AgentIdentity } from "@arceus/contracts";
import { getRoleSoul } from "@arceus/company-runtime";

/** Map role capabilities to OpenCode tool flags. */
export function getToolsForPrompt(role: AgentIdentity["role"]): Record<string, boolean> | undefined {
  const soul = getRoleSoul(role);
  if (!soul.canWriteCode && !soul.canEditFiles && !soul.canRunShell) return undefined;
  return {
    read: true,
    glob: true,
    grep: true,
    ...(soul.canWriteCode ? { write: true, edit: true, apply_patch: true } : {}),
    ...(soul.canEditFiles ? { write: true, edit: true } : {}),
    ...(soul.canRunShell ? { bash: true } : {}),
  };
}
