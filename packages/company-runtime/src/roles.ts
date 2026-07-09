import type { RoleSoul } from "@arceus/contracts";
import {
  CEO_PROMPT,
  CTO_PROMPT,
  PM_PROMPT,
  DEVELOPER_PROMPT,
  TESTER_PROMPT,
  UI_DESIGNER_PROMPT,
  MARKETING_PROMPT,
  SKILLS_LEAD_PROMPT,
} from "@arceus/prompts";

export const ROLE_SOULS: Record<RoleSoul["role"], RoleSoul> = {
  ceo: {
    role: "ceo",
    purpose: "Operate as the board-facing founder of the company and turn broad ideas into executable first releases.",
    systemPrompt: CEO_PROMPT,
    canWriteCode: false,
    canEditFiles: false,
    canRunShell: false,
    canApproveStrategy: false,
    canRequestHiring: true,
    allowedDirectReports: ["cto", "marketing"],
    defaultCapabilities: ["Board communication", "Strategic narrowing", "Hiring requests", "Meeting orchestration"]
  },
  cto: {
    role: "cto",
    purpose: "Translate approved strategy into architecture specs, API contracts, and data models.",
    systemPrompt: CTO_PROMPT,
    canWriteCode: false,
    canEditFiles: true,
    canRunShell: false,
    canApproveStrategy: false,
    canRequestHiring: true,
    allowedDirectReports: ["pm", "developer", "tester", "ui_designer", "skills_lead"],
    defaultCapabilities: ["Architecture planning", "Data modeling", "Specification writing", "Technical escalation"]
  },
  pm: {
    role: "pm",
    purpose: "Constrain scope, convert strategy into backlog, and keep execution legible to the board.",
    systemPrompt: PM_PROMPT,
    canWriteCode: false,
    canEditFiles: true,
    canRunShell: false,
    canApproveStrategy: false,
    canRequestHiring: false,
    allowedDirectReports: ["developer", "tester", "ui_designer"],
    defaultCapabilities: ["Backlog shaping", "Acceptance criteria", "Scope control", "Meeting synthesis"]
  },
  developer: {
    role: "developer",
    purpose: "Produce the runnable local product artifact from approved tasks and technical direction.",
    systemPrompt: DEVELOPER_PROMPT,
    canWriteCode: true,
    canEditFiles: true,
    canRunShell: true,
    canApproveStrategy: false,
    canRequestHiring: false,
    allowedDirectReports: [],
    defaultCapabilities: ["Code generation", "Refactoring", "Tool execution", "Local workspace build"]
  },
  tester: {
    role: "tester",
    purpose: "Validate runnable apps and services through browser checks, smoke tests, quality gates, and test file authoring.",
    systemPrompt: TESTER_PROMPT,
    canWriteCode: true,
    canEditFiles: true,
    canRunShell: true,
    canApproveStrategy: false,
    canRequestHiring: false,
    allowedDirectReports: [],
    defaultCapabilities: ["Browser QA", "Smoke testing", "Accessibility validation", "Service verification"]
  },
  ui_designer: {
    role: "ui_designer",
    purpose: "Own visual direction, interface critique, and design quality for product experiences.",
    systemPrompt: UI_DESIGNER_PROMPT,
    canWriteCode: false,
    canEditFiles: true,
    canRunShell: false,
    canApproveStrategy: false,
    canRequestHiring: false,
    allowedDirectReports: [],
    defaultCapabilities: ["Visual direction", "UX critique", "Design systems", "Polish guidance"]
  },
  marketing: {
    role: "marketing",
    purpose: "Prepare positioning, launch content, and distribution plans for what the company ships.",
    systemPrompt: MARKETING_PROMPT,
    canWriteCode: false,
    canEditFiles: true,
    canRunShell: false,
    canApproveStrategy: false,
    canRequestHiring: false,
    allowedDirectReports: [],
    defaultCapabilities: ["Positioning", "Launch messaging", "Email drafts", "Campaign planning"]
  },
  skills_lead: {
    role: "skills_lead",
    purpose: "Capture repeated workflows as reusable skills and keep the company knowledge base operational.",
    systemPrompt: SKILLS_LEAD_PROMPT,
    canWriteCode: true,
    canEditFiles: true,
    canRunShell: true,
    canApproveStrategy: false,
    canRequestHiring: false,
    allowedDirectReports: [],
    defaultCapabilities: ["Skill authoring", "Workflow packaging", "Operational playbooks", "Knowledge curation"]
  }
};

/** Look up the RoleSoul definition for a given role key. */
export function getRoleSoul(role: RoleSoul["role"]) {
  return ROLE_SOULS[role];
}

/** Check if managerRole is allowed to have childRole as a direct report. */
export function canManageRole(managerRole: RoleSoul["role"], childRole: RoleSoul["role"]) {
  return ROLE_SOULS[managerRole].allowedDirectReports.includes(childRole);
}

/** Roles that must always be present in every company org chart. */
export const MANDATORY_ROLES: readonly string[] = ["tester", "skills_lead"];

// ── Typed role tables ─────────────────────────────────────────────────────
// Replace scattered `if (role === "...")` chains with typed Record lookups.
// See plans/code-audit/anti-patterns.md #9.

type Role = RoleSoul["role"];

/** Display names per role. Keyed lookup replaces the if/else chain in store.ts. */
export const ROLE_DISPLAY_NAMES: Record<Role, string> = {
  ceo: "Avery",
  cto: "Lin",
  pm: "Mina",
  developer: "Jules",
  tester: "Quinn",
  ui_designer: "Sage",
  marketing: "Parker",
  skills_lead: "Rowan",
};

/**
 * Runtime capabilities surfaced to the orchestrator/event-bridge.
 * Used instead of `if (role === "developer")` checks. Add new flags here as
 * cross-cutting role behaviour is identified.
 */
export interface RoleRuntimeCapabilities {
  /** Owns the product workspace lifecycle: scaffolding, watchdog, preview detection. */
  ownsProductWorkspace: boolean;
  /** Session errors trigger an escalation meeting to leadership. */
  escalatesOnSessionError: boolean;
  /** Receives ALL sprint tasks in beat context (not just self-assigned) — used by sprint-completion overseers. */
  seesAllSprintTasks: boolean;
  /** Gets visibility into in-flight bug-fix tasks during sprint review. */
  verifiesSprintReviews: boolean;
  /** Beat context refreshes the workspace build status before assembly. */
  receivesBuildContext: boolean;
  /** Beat context is augmented with skills-health / unused-skill / gap-analysis data. */
  receivesSkillsLeadContext: boolean;
  /** Strategic role that may receive freeform/unstructured checklist actions and respond via LLM. */
  respondsToFreeformChecklistActions: boolean;
}

export const ROLE_CAPABILITIES: Record<Role, RoleRuntimeCapabilities> = {
  ceo:         { ownsProductWorkspace: false, escalatesOnSessionError: false, seesAllSprintTasks: true,  verifiesSprintReviews: false, receivesBuildContext: false, receivesSkillsLeadContext: false, respondsToFreeformChecklistActions: true  },
  cto:         { ownsProductWorkspace: false, escalatesOnSessionError: false, seesAllSprintTasks: false, verifiesSprintReviews: false, receivesBuildContext: false, receivesSkillsLeadContext: false, respondsToFreeformChecklistActions: true  },
  pm:          { ownsProductWorkspace: false, escalatesOnSessionError: false, seesAllSprintTasks: true,  verifiesSprintReviews: false, receivesBuildContext: false, receivesSkillsLeadContext: false, respondsToFreeformChecklistActions: true  },
  developer:   { ownsProductWorkspace: true,  escalatesOnSessionError: true,  seesAllSprintTasks: false, verifiesSprintReviews: false, receivesBuildContext: true,  receivesSkillsLeadContext: false, respondsToFreeformChecklistActions: false },
  tester:      { ownsProductWorkspace: false, escalatesOnSessionError: false, seesAllSprintTasks: false, verifiesSprintReviews: true,  receivesBuildContext: false, receivesSkillsLeadContext: false, respondsToFreeformChecklistActions: false },
  ui_designer: { ownsProductWorkspace: false, escalatesOnSessionError: false, seesAllSprintTasks: false, verifiesSprintReviews: false, receivesBuildContext: false, receivesSkillsLeadContext: false, respondsToFreeformChecklistActions: false },
  marketing:   { ownsProductWorkspace: false, escalatesOnSessionError: false, seesAllSprintTasks: false, verifiesSprintReviews: false, receivesBuildContext: false, receivesSkillsLeadContext: false, respondsToFreeformChecklistActions: false },
  skills_lead: { ownsProductWorkspace: false, escalatesOnSessionError: false, seesAllSprintTasks: false, verifiesSprintReviews: false, receivesBuildContext: false, receivesSkillsLeadContext: true,  respondsToFreeformChecklistActions: false },
};

/** Azure OpenAI deployment per role. All employees use the CEO-class (gpt-5.2) pool. */
export const ROLE_DEPLOYMENT_MODEL: Record<Role, string> = {
  ceo:         "azure/ceo-deployment",
  cto:         "azure/ceo-deployment",
  pm:          "azure/ceo-deployment",
  developer:   "azure/ceo-deployment",
  tester:      "azure/ceo-deployment",
  ui_designer: "azure/ceo-deployment",
  marketing:   "azure/ceo-deployment",
  skills_lead: "azure/ceo-deployment",
};

/** Initial agent status assigned at hire time. CEO boots as "running" because the company is led from the top. */
export const ROLE_INITIAL_AGENT_STATUS: Record<Role, "running" | "active"> = {
  ceo:         "running",
  cto:         "active",
  pm:          "active",
  developer:   "active",
  tester:      "active",
  ui_designer: "active",
  marketing:   "active",
  skills_lead: "active",
};

/**
 * Validate a proposed org-chart hierarchy against role policies.
 * Throws on unsupported roles, duplicates, illegal reporting lines,
 * or missing mandatory roles (tester, skills_lead).
 */
export function assertRoleHierarchy(roles: { role: string; parent_role: string | null }[]) {
  const seen = new Set<string>();

  for (const entry of roles) {
    if (!(entry.role in ROLE_SOULS)) {
      throw new Error(`Unsupported role proposed by CEO: ${entry.role}`);
    }

    if (seen.has(entry.role)) {
      throw new Error(`Duplicate role proposed in hierarchy: ${entry.role}`);
    }
    seen.add(entry.role);

    if (entry.parent_role) {
      if (!(entry.parent_role in ROLE_SOULS)) {
        throw new Error(`Unsupported manager role proposed by CEO: ${entry.parent_role}`);
      }

      if (!canManageRole(entry.parent_role as RoleSoul["role"], entry.role as RoleSoul["role"])) {
        throw new Error(`Role policy violation: ${entry.parent_role} cannot directly orchestrate ${entry.role}`);
      }
    }
  }

  for (const required of MANDATORY_ROLES) {
    if (!seen.has(required)) {
      throw new Error(`Org chart is missing mandatory role: "${required}". Every company must include tester and skills_lead.`);
    }
  }
}
