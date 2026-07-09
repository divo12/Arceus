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
  todo_write: true,
  beat_read_last_progress: true,
} as const;

const TIER_B_COMMON_EXECUTOR = {
  task_complete: true,
  task_block: true,
  task_append_result: true,
  artifact_create: true,
} as const;

export const ALL_ARCEUS_TOOLS = [
  // Tier A — every executor
  "task_update_progress",
  "task_append_command",
  "todo_write",
  "beat_read_last_progress",
  // Tier B — most executors
  "task_complete",
  "task_block",
  "task_append_result",
  "task_set_preview_url",
  "task_verify",
  "artifact_create",
  "artifact_write_to_workspace",
  "workspace_checkpoint",
  "workspace_start_preview",
  "workspace_probe_preview",
  "workspace_get_preview_url",
  "workspace_get_build_health",
  "workspace_check_exports",
  "workspace_verify_baseline",
  // Task management
  "task_create",
  "task_update",
  "task_get",
  "task_get_preview_path",
  "task_list_progress",
  "task_clear_progress",
  "task_claim",
  "task_report_bug",
  "task_hydrate_from_spec",
  "task_attach_artifact",
  // Artifacts
  "artifact_get",
  "artifact_list_sprint",
  "artifact_persist",
  // Sprints
  "sprint_create",
  "sprint_get_active",
  "sprint_check_completion",
  "sprint_run_qa_gate",
  "sprint_run_final_gate",
  "sprint_finalize",
  // Approvals
  "approval_request",
  "approval_get",
  "approval_list",
  "approval_update",
  "approval_decide",
  // Meetings
  "meeting_record",
  "meeting_get",
  "meeting_request_decision",
  "meeting_contribute",
  "meeting_request",
  // Company / execution
  "company_get_summary",
  "agents_list_sessions",
  "company_set_status",
  "board_get_messages",
  "execution_get_status",
  "execution_complete_cycle",
  "execution_pause",
  "execution_reconcile",
  "execution_stop",
  // Workspace role-custom (Spec 28 Phase H)
  "workspace_run_typecheck",
  "workspace_capture_browser_probe",
  "workspace_run_flow_test",
  "workspace_deploy_production",
  "workspace_get_production_url",
  "workspace_collect_evidence",
  "workspace_run_acceptance_suite",
  "workspace_diff_against_criteria",
  // Memory — spec 27 §6
  "memory_search",
  "memory_add_learning",
  "memory_handoff",
  // Meta
  "tool_help",
  "arceus_tool_search",
  // Spec 29 — Skills-Lead tools
  "skill_health_report",
  "skill_audit_unused",
  "skill_inspect_history",
  "skill_validate_definition",
  "skill_register",
  "skill_update",
  "skill_deprecate",
  // Spec 35 — chat surface
  "chat_emit_card",
  // Strategy
  "strategy_apply",
] as const;

const MEMORY_ALL = {
  memory_search: true,
  memory_add_learning: true,
  memory_handoff: true,
} as const;

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
    model: "azure/gpt-5.2",
    description: "Board-facing CEO that refines ideas, proposes strategy, and requests approvals.",
    promptFile: "./.opencode/prompts/ceo-soul.txt",
    permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_create: true,
      task_get: true,
      task_list_progress: true,
      task_hydrate_from_spec: true,
      task_attach_artifact: true,
      meeting_record: true,
      meeting_get: true,
      meeting_request_decision: true,
      meeting_contribute: true,
      // Spec 35 §5 — async "check with the team" meetings
      meeting_request: true,
      sprint_create: true,
      sprint_get_active: true,
      sprint_check_completion: true,
      sprint_finalize: true,
      approval_get: true,
      approval_list: true,
      approval_update: true,
      approval_decide: true,
      company_get_summary: true,
      agents_list_sessions: true,
      company_set_status: true,
      board_get_messages: true,
      execution_get_status: true,
      execution_complete_cycle: true,
      execution_pause: true,
      execution_reconcile: true,
      execution_stop: true,
      // Spec 29 — read-only skill insights for CEO
      skill_health_report: true,
      skill_audit_unused: true,
      skill_inspect_history: true,
      // Spec 35 — CEO is the only role that can emit chat cards
      chat_emit_card: true,
      // Strategy — CEO provisions agents via tool call after board approval
      strategy_apply: true,
      workspace_get_production_url: true,
    }),
  },
  cto: {
    mode: "primary",
    model: "azure/gpt-5.2",
    description: "Technical lead that decomposes strategy into architecture and execution plans.",
    promptFile: "./.opencode/prompts/cto-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_get: true,
      task_list_progress: true,
      task_clear_progress: true,
      task_claim: true,
      task_report_bug: true,
      task_attach_artifact: true,
      artifact_get: true,
      artifact_list_sprint: true,
      sprint_get_active: true,
      sprint_check_completion: true,
      sprint_run_qa_gate: true,
      sprint_run_final_gate: true,
      workspace_get_build_health: true,
      workspace_verify_baseline: true,
      workspace_deploy_production: true,
      workspace_get_production_url: true,
      meeting_get: true,
      meeting_contribute: true,
      approval_get: true,
      approval_list: true,
      company_get_summary: true,
      board_get_messages: true,
      execution_get_status: true,
    }),
  },
  pm: {
    mode: "primary",
    model: "azure/gpt-5.2",
    description: "Product manager focused on scope control, backlog discipline, and meeting synthesis.",
    promptFile: "./.opencode/prompts/pm-soul.txt",
    permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_create: true,
      task_update: true,
      task_get: true,
      task_claim: true,
      task_list_progress: true,
      task_clear_progress: true,
      task_report_bug: true,
      task_attach_artifact: true,
      artifact_get: true,
      artifact_list_sprint: true,
      artifact_persist: true,
      sprint_get_active: true,
      sprint_check_completion: true,
      meeting_record: true,
      meeting_get: true,
      meeting_request_decision: true,
      meeting_contribute: true,
      approval_request: true,
      approval_get: true,
      approval_list: true,
      approval_update: true,
      company_get_summary: true,
      board_get_messages: true,
    }),
  },
  developer: {
    mode: "primary",
    model: "azure/gpt-5.2",
    description: "Execution-focused builder that produces a runnable local workspace.",
    promptFile: "./.opencode/prompts/developer-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_set_preview_url: true,
      task_get: true,
      task_get_preview_path: true,
      task_list_progress: true,
      task_claim: true,
      task_report_bug: true,
      artifact_write_to_workspace: true,
      workspace_checkpoint: true,
      workspace_start_preview: true,
      workspace_probe_preview: true,
      workspace_run_typecheck: true,
      workspace_get_preview_url: true,
      workspace_get_build_health: true,
      workspace_check_exports: true,
      workspace_verify_baseline: true,
      workspace_deploy_production: true,
      workspace_get_production_url: true,
      task_attach_artifact: true,
      artifact_get: true,
      artifact_list_sprint: true,
      sprint_get_active: true,
      meeting_contribute: true,
      company_get_summary: true,
    }),
  },
  tester: {
    mode: "primary",
    model: "azure/gpt-5.2",
    description: "Quality specialist that validates apps and services through browser, accessibility, and smoke testing workflows.",
    promptFile: "./.opencode/prompts/tester-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_verify: true,
      task_get: true,
      task_get_preview_path: true,
      task_list_progress: true,
      task_claim: true,
      task_report_bug: true,
      task_attach_artifact: true,
      artifact_get: true,
      artifact_list_sprint: true,
      sprint_get_active: true,
      sprint_run_qa_gate: true,
      workspace_capture_browser_probe: true,
      workspace_run_flow_test: true,
      workspace_collect_evidence: true,
      workspace_run_acceptance_suite: true,
      workspace_diff_against_criteria: true,
      workspace_get_preview_url: true,
      workspace_get_build_health: true,
      workspace_check_exports: true,
      workspace_verify_baseline: true,
      meeting_contribute: true,
      company_get_summary: true,
    }),
  },
  ui_designer: {
    mode: "primary",
    model: "azure/gpt-5.2",
    description: "Design specialist that creates visual direction, UX guidance, and interface critique.",
    promptFile: "./.opencode/prompts/ui-designer-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      edit: true,
      write: true,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_set_preview_url: true,
      task_get: true,
      task_claim: true,
      task_report_bug: true,
      artifact_write_to_workspace: true,
      task_attach_artifact: true,
      artifact_get: true,
      sprint_get_active: true,
      meeting_contribute: true,
      company_get_summary: true,
    }),
  },
  marketing: {
    mode: "primary",
    model: "azure/gpt-5.2",
    description: "Launch specialist that prepares positioning, campaigns, and distribution-ready copy.",
    promptFile: "./.opencode/prompts/marketing-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "deny" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_READONLY,
      edit: true,
      write: true,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_get: true,
      task_claim: true,
      task_report_bug: true,
      artifact_write_to_workspace: true,
      artifact_get: true,
      approval_request: true,
      approval_update: true,
      task_attach_artifact: true,
      sprint_get_active: true,
      meeting_contribute: true,
      company_get_summary: true,
      workspace_get_production_url: true,
    }),
  },
  skills_lead: {
    mode: "primary",
    model: "azure/gpt-5.2",
    description: "Operational specialist that authors and maintains reusable skills for the company.",
    promptFile: "./.opencode/prompts/skills-lead-soul.txt",
    permission: { edit: "allow", write: "allow", bash: { "*": "allow" }, webfetch: "allow" },
    tools: denyRest({
      ...BUILTIN_EDITOR,
      ...TIER_A_ALL_EXECUTORS,
      ...TIER_B_COMMON_EXECUTOR,
      ...MEMORY_ALL,
      task_get: true,
      task_claim: true,
      task_report_bug: true,
      workspace_checkpoint: true,
      artifact_persist: true,
      artifact_get: true,
      artifact_list_sprint: true,
      meeting_record: true,
      meeting_contribute: true,
      approval_request: true,
      approval_update: true,
      task_attach_artifact: true,
      sprint_get_active: true,
      company_get_summary: true,
      // Spec 29 — full skills toolkit
      skill_health_report: true,
      skill_audit_unused: true,
      skill_inspect_history: true,
      skill_validate_definition: true,
      skill_register: true,
      skill_update: true,
      skill_deprecate: true,
    }),
  },
};

export const ROLES: Role[] = Object.keys(ROLE_CONFIGS) as Role[];

export const getAllowedArceusTools = (role: Role): string[] =>
  Object.entries(ROLE_CONFIGS[role].tools)
    .filter(([name, enabled]) => enabled && (ALL_ARCEUS_TOOLS as readonly string[]).includes(name))
    .map(([name]) => name);
