/**
 * Spec 13 – Step 3: Base Policy Rules
 *
 * Deterministic, code-defined policy rules that govern which tools each role
 * can access. Sorted by priority (higher = evaluated first). First matching
 * rule wins; if nothing matches, the default is ALLOW.
 *
 * Tool names map to OpenCode tool flags:
 *   write, edit, apply_patch  → code-writing tools
 *   bash                      → shell execution
 *   read, glob, grep          → read-only filesystem
 */

import type { PolicyRule, RoleSoul } from "@arceus/contracts";

// ── Helpers ─────────────────────────────────────────────────

/** Create a rule with sensible defaults filled in. */
function rule(
  partial: Omit<PolicyRule, "enabled" | "priority" | "minTrust"> & { enabled?: boolean; priority?: number; minTrust?: number }
): PolicyRule {
  return { enabled: true, priority: 0, minTrust: 0, ...partial };
}

/** Roles that must never have code-writing tools. */
const NON_CODING_ROLES: RoleSoul["role"][] = ["ceo", "pm", "marketing"];

/** Roles that must never run shell commands. */
const NO_SHELL_ROLES: RoleSoul["role"][] = ["ceo", "pm", "ui_designer", "marketing"];

/** All code-writing tool names in OpenCode. */
const CODE_WRITE_TOOLS = ["write", "edit", "apply_patch"];

/** Shell execution tools. */
const SHELL_TOOLS = ["bash"];

/** All tools combined for total lockout scenarios. */
const ALL_TOOLS = ["read", "glob", "grep", "write", "edit", "apply_patch", "bash"];

// ── Rules ───────────────────────────────────────────────────

/**
 * Rule 1 – Budget exhausted: no agent gets any tools.
 * This is evaluated externally via the budget context flag, not by matching
 * tool patterns. The governance gateway checks companyBudgetRemainingCents
 * and if ≤ 0, returns an empty tool set before rule evaluation.
 * Kept here as documentation / audit reference.
 */
const budgetExhausted: PolicyRule = rule({
  id: "budget-exhausted",
  name: "Budget Exhausted – Total Lockout",
  description: "When company budget is exhausted, deny all tool access to all agents.",
  appliesTo: [],
  toolPatterns: ["*"],
  decision: "deny",
  priority: 1000,
  enabled: false,  // Evaluated externally via budget context flag, not via rule engine
});

/**
 * Rule 2 – CEO cannot write code or run shell.
 */
const ceoNoCode: PolicyRule = rule({
  id: "ceo-no-code",
  name: "CEO: No Code Tools",
  description: "CEO must not have code-writing or shell-execution tools.",
  appliesTo: ["ceo"],
  toolPatterns: [...CODE_WRITE_TOOLS, ...SHELL_TOOLS],
  decision: "deny",
  priority: 900,
});

/**
 * Rule 3 – PM cannot write code or run shell.
 */
const pmNoCode: PolicyRule = rule({
  id: "pm-no-code",
  name: "PM: No Code Tools",
  description: "PM must not have code-writing or shell-execution tools.",
  appliesTo: ["pm"],
  toolPatterns: [...CODE_WRITE_TOOLS, ...SHELL_TOOLS],
  decision: "deny",
  priority: 900,
});

/**
 * Rule 4 – Marketing cannot write code or run shell.
 */
const marketingNoCode: PolicyRule = rule({
  id: "marketing-no-code",
  name: "Marketing: No Code Tools",
  description: "Marketing must not have code-writing or shell-execution tools.",
  appliesTo: ["marketing"],
  toolPatterns: [...CODE_WRITE_TOOLS, ...SHELL_TOOLS],
  decision: "deny",
  priority: 900,
});

/**
 * Rule 5 – UI Designer cannot run shell.
 */
const uiDesignerNoShell: PolicyRule = rule({
  id: "ui-designer-no-shell",
  name: "UI Designer: No Shell",
  description: "UI Designer must not have shell-execution tools.",
  appliesTo: ["ui_designer"],
  toolPatterns: SHELL_TOOLS,
  decision: "deny",
  priority: 900,
});

/**
 * Rule 6 – Critical trust: deny all destructive tools.
 * Agents with trust < 0.3 lose write/edit/shell access.
 */
const criticalTrustLockout: PolicyRule = rule({
  id: "critical-trust-lockout",
  name: "Critical Trust: Destructive Tool Lockout",
  description: "Agents with trust score below 0.3 lose write, edit, and shell access.",
  appliesTo: [],
  toolPatterns: [...CODE_WRITE_TOOLS, ...SHELL_TOOLS],
  minTrust: 0.3,
  decision: "deny",
  priority: 800,
});

/**
 * Rule 7 – Restricted trust: shell escalation.
 * Agents with trust 0.3–0.5 need escalation to use shell.
 */
const restrictedTrustShellEscalation: PolicyRule = rule({
  id: "restricted-trust-shell-escalate",
  name: "Restricted Trust: Shell Escalation",
  description: "Agents with trust score below 0.5 must escalate shell usage to their manager.",
  appliesTo: [],
  toolPatterns: SHELL_TOOLS,
  minTrust: 0.5,
  decision: "escalate",
  priority: 700,
});

/**
 * Rule 8 – Standard trust: apply_patch escalation.
 * Agents with trust 0.5–0.7 need escalation for apply_patch (bulk edits).
 */
const standardTrustPatchEscalation: PolicyRule = rule({
  id: "standard-trust-patch-escalate",
  name: "Standard Trust: Patch Escalation",
  description: "Agents with trust below 0.7 must escalate apply_patch (bulk edits).",
  appliesTo: [],
  toolPatterns: ["apply_patch"],
  minTrust: 0.7,
  decision: "escalate",
  priority: 600,
});

/**
 * Rule 9 – CTO: no direct code writing.
 * CTO can edit files and run shell but shouldn't write raw code.
 */
const ctoNoRawCode: PolicyRule = rule({
  id: "cto-no-raw-code",
  name: "CTO: No Raw Code Writing",
  description: "CTO should delegate code writing to developers, not write code directly.",
  appliesTo: ["cto"],
  toolPatterns: ["write", "apply_patch"],
  decision: "deny",
  priority: 500,
});

/**
 * Rule 10 – Tester: no code writing (production code).
 * Testers can read files and run shell (for test commands) but not write production code.
 * See Rule 10b for the test-file carve-out.
 */
const testerNoCodeWrite: PolicyRule = rule({
  id: "tester-no-code-write",
  name: "Tester: No Production Code Writing",
  description: "Testers validate via shell and file reading; they must not write production code.",
  appliesTo: ["tester"],
  toolPatterns: ["write", "apply_patch"],
  decision: "deny",
  priority: 500,
});

/**
 * Rule 10b – Tester: allow writing test files only (Spec 21).
 * Higher priority than Rule 10, creates a carve-out for *.test.* and *.spec.* files.
 * Runtime enforcement checks file path against test patterns.
 */
const testerWriteTestsOnly: PolicyRule = rule({
  id: "tester-write-tests-only",
  name: "Tester: Write Tests Only",
  description: "Tester can write/edit only test files (*.test.*, *.spec.*). Production code is denied by Rule 10.",
  appliesTo: ["tester"],
  toolPatterns: ["write", "edit", "apply_patch"],
  decision: "allow",
  priority: 550,
  filePattern: "\\.(test|spec)\\.",
});

/**
 * Rule 11 – Read-only tools are always allowed for everyone.
 * This is a low-priority ALLOW that acts as a safety net for read tools.
 */
const readToolsAlwaysAllowed: PolicyRule = rule({
  id: "read-tools-allowed",
  name: "Read Tools: Always Allowed",
  description: "All roles can use read, glob, and grep tools regardless of trust.",
  appliesTo: [],
  toolPatterns: ["read", "glob", "grep"],
  decision: "allow",
  priority: 100,
});

// ── Exported rule set ───────────────────────────────────────

/** All base policy rules, pre-sorted by priority descending. */
export const BASE_POLICY_RULES: PolicyRule[] = [
  budgetExhausted,
  ceoNoCode,
  pmNoCode,
  marketingNoCode,
  uiDesignerNoShell,
  criticalTrustLockout,
  restrictedTrustShellEscalation,
  standardTrustPatchEscalation,
  testerWriteTestsOnly,
  ctoNoRawCode,
  testerNoCodeWrite,
  readToolsAlwaysAllowed,
].sort((a, b) => b.priority - a.priority);

/**
 * Lookup: which roles are in the non-coding set?
 * Useful for quick checks outside the full policy engine.
 */
export const NON_CODING_ROLE_SET = new Set<string>(NON_CODING_ROLES);
export const NO_SHELL_ROLE_SET = new Set<string>(NO_SHELL_ROLES);
