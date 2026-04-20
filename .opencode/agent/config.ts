export type Role =
  | "ceo"
  | "cto"
  | "pm"
  | "developer"
  | "tester"
  | "ui_designer"
  | "marketing"
  | "skills_lead";

export type ToolVisibility = Record<string, boolean>;

export interface RoleAgentConfig {
  mode: "primary" | "subagent";
  model: string;
  description: string;
  promptFile: string;
  permission: {
    edit: "allow" | "deny";
    write?: "allow" | "deny";
    bash: { "*": "allow" | "deny" };
    webfetch: "allow" | "deny";
  };
  tools: ToolVisibility;
}

const BUILTIN_READONLY = {
  read: true,
  grep: true,
  glob: true,
  webfetch: true,
  skill: true,
  tool_help: true,
} as const;

const BUILTIN_EDITOR = {
  ...BUILTIN_READONLY,
  edit: true,
  write: true,
  bash: true,
} as const;

const TIER_A_ALL_EXECUTORS = {
  task_update_progress: true,
  task_append_command: true,
  task_append_plan_step: true,
} as const;

const TIER_B_COMMON_EXECUTOR = {
  task_complete: true,
  task_block: true,
  task_append_result: true,
  artifact_create: true,
} as const;

const ALL_ARCEUS_TOOLS = [
  "task_update_progress",
  "task_append_command",
  "task_append_plan_step",
  "task_complete",
  "task_block",
  "task_append_result",
  "task_set_preview_url",
  "task_verify",
  "artifact_create",
  "artifact_write_to_workspace",
  "workspace_checkpoint",
  "workspace_probe_preview",
  "task_create",
  "task_update",
  "task_hydrate_from_spec",
  "task_attach_artifact",
  "artifact_persist",
  "meeting_record",
  "approval_request",
  "sprint_propose",
  "tool_help",
  "arceus_tool_search",
] as const;

const denyRest = (allowed: ToolVisibility): ToolVisibility => {
  const result: ToolVisibility = { ...allowed };
  for (const tool of ALL_ARCEUS_TOOLS) {
    if (!(tool in result)) result[tool] = false;
  }
  return result;
};

export const ROLE_CONFIGS: Record<Role, RoleAgentConfig> = {
  ceo: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Board-facing CEO that refines ideas, proposes strategy, and requests approvals.",
    promptFile: "./.opencode/prompts/ceo-soul.txt",
    permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      task_create: true,
      task_hydrate_from_spec: true,
      task_attach_artifact: true,
      meeting_record: true,
      sprint_propose: true,
    }),
  },
  cto: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Technical lead that decomposes strategy into architecture and execution plans.",
    promptFile: "./.opencode/prompts/cto-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      task_attach_artifact: true,
    }),
  },
  pm: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Product manager focused on scope control, backlog discipline, and meeting synthesis.",
    promptFile: "./.opencode/prompts/pm-soul.txt",
    permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      task_create: true,
      task_update: true,
      task_attach_artifact: true,
      artifact_persist: true,
      meeting_record: true,
      approval_request: true,
    }),
  },
  developer: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Execution-focused builder that produces a runnable local workspace.",
    promptFile: "./.opencode/prompts/developer-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      task_set_preview_url: true,
      artifact_write_to_workspace: true,
      workspace_checkpoint: true,
      workspace_probe_preview: true,
      task_attach_artifact: true,
    }),
  },
  tester: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Quality specialist that validates apps and services through browser, accessibility, and smoke testing workflows.",
    promptFile: "./.opencode/prompts/tester-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      task_verify: true,
      task_attach_artifact: true,
    }),
  },
  ui_designer: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Design specialist that creates visual direction, UX guidance, and interface critique.",
    promptFile: "./.opencode/prompts/ui-designer-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      edit: true,
      write: true,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      task_set_preview_url: true,
      artifact_write_to_workspace: true,
      task_attach_artifact: true,
    }),
  },
  marketing: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Launch specialist that prepares positioning, campaigns, and distribution-ready copy.",
    promptFile: "./.opencode/prompts/marketing-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      edit: true,
      write: true,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      artifact_write_to_workspace: true,
      approval_request: true,
      task_attach_artifact: true,
    }),
  },
  skills_lead: {
    mode: "primary",
    model: "azure/gpt-4.1",
    description: "Operational specialist that authors and maintains reusable skills for the company.",
    promptFile: "./.opencode/prompts/skills-lead-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      workspace_checkpoint: true,
      artifact_persist: true,
      meeting_record: true,
      approval_request: true,
      task_attach_artifact: true,
    }),
  },
};

export const ROLES: Role[] = Object.keys(ROLE_CONFIGS) as Role[];

export const getAllowedArceusTools = (role: Role): string[] =>
  Object.entries(ROLE_CONFIGS[role].tools)
    .filter(([name, enabled]) => enabled && (ALL_ARCEUS_TOOLS as readonly string[]).includes(name))
    .map(([name]) => name);
