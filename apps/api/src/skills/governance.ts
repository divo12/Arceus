/**
 * Spec 14 Phase 6 — Skill Evolution Governance
 *
 * Guardrails for skill mutations to prevent runaway self-evolution:
 *   - Trust tier gate: proposer must have trust ≥ 0.5
 *   - Own-role mutation: agents can only mutate their own role's skills
 *     (except Skills Lead, which is explicitly cross-role)
 *   - Per-sprint mutation cap: max 5 proposals per sprint
 *   - Per-sprint cost budget: $0.30 cumulative across evolution LLM calls
 *   - Shell-command lint: skill content cannot contain shell/system invocations
 *
 * All refusals are logged to the audit ledger with structured detail so
 * they surface in the logs UI + the /api/governance endpoints.
 *
 * Storage model: per-sprint counters live in-memory (Map keyed by sprintId).
 * The counters reset implicitly when a new sprintId is seen; there is no
 * explicit sprint-end hook required for correctness.
 */

import type { AgentIdentity, SkillMutation } from "@arceus/contracts";
import { updateMutationStatus } from "@arceus/company-runtime";
import { cpLoadTrustScore } from "../persistence/control-plane/index.js";
import { auditAgent, auditSystem } from "../observability/audit-ledger.js";

// ── Constants (spec §1183–1190) ───────────────────────────

/** Minimum trust score to propose a skill mutation (spec §1184). */
export const MIN_TRUST_FOR_MUTATION = 0.5;

/** Maximum mutation proposals per sprint (spec §1186). */
export const MAX_MUTATIONS_PER_SPRINT = 5;

/** Per-sprint evolution cost ceiling in cents (spec §1190 — $0.30). */
export const SPRINT_EVOLUTION_BUDGET_CENTS = 30;

// ── Shell-command lint ────────────────────────────────────

/**
 * Patterns that indicate an attempt to smuggle shell/system calls into a
 * skill body. Intentionally conservative — if a skill *legitimately* needs
 * to describe a shell command in prose, it should use fenced code blocks
 * with language "text" or wrap the command in single backticks + quotes.
 */
const SHELL_COMMAND_PATTERNS: RegExp[] = [
  /\bexec(Sync|File|FileSync)?\s*\(/,      // Node child_process
  /\brequire\(\s*["']child_process["']/,   // dynamic import
  /\bspawn(Sync)?\s*\(/,
  /\$\(\s*[\w./-]/,                         // command substitution $(cmd)
  /\bbash\s+-c\b/,
  /\bsh\s+-c\b/,
  /\bcurl\s+[^\s|`]+\s+\|\s*(bash|sh)\b/,  // curl | bash
  /\brm\s+-rf\s+\//,                         // destructive
  /\bsudo\s+/,
];

/** Scan skill content for forbidden shell/system command patterns. */
export function lintSkillContent(content: string): {
  clean: boolean;
  findings: string[];
} {
  const findings: string[] = [];
  for (const pattern of SHELL_COMMAND_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      findings.push(`Forbidden pattern ${pattern.source}: ${match[0]}`);
    }
  }
  return { clean: findings.length === 0, findings };
}

// ── Per-sprint counters ───────────────────────────────────

interface SprintBudgetRecord {
  sprintId: string;
  mutationCount: number;
  budgetCentsSpent: number;
  proposals: {
    mutationId: string;
    proposedBy: string;
    costCents: number;
    at: string;
  }[];
}

const sprintBudgets = new Map<string, SprintBudgetRecord>();

function getOrInitSprintBudget(sprintId: string): SprintBudgetRecord {
  let existing = sprintBudgets.get(sprintId);
  if (!existing) {
    existing = {
      sprintId,
      mutationCount: 0,
      budgetCentsSpent: 0,
      proposals: [],
    };
    sprintBudgets.set(sprintId, existing);
  }
  return existing;
}

/** Return a snapshot of the mutation budget counters for a sprint. */
export function getSprintBudget(sprintId: string): Readonly<SprintBudgetRecord> {
  return { ...getOrInitSprintBudget(sprintId) };
}

/** Reset the mutation budget counters for a single sprint. */
export function resetSprintBudget(sprintId: string): void {
  sprintBudgets.delete(sprintId);
}

/** Reset mutation budget counters for all sprints (test helper). */
export function resetAllSprintBudgets(): void {
  sprintBudgets.clear();
}

// ── Governance decision ───────────────────────────────────

export interface GovernanceRefusal {
  allowed: false;
  reason: string;
  code:
    | "trust_too_low"
    | "cross_role_mutation"
    | "sprint_cap_exceeded"
    | "budget_exceeded"
    | "shell_command_detected";
  detail: Record<string, unknown>;
}

export interface GovernanceApproval {
  allowed: true;
  trustScore: number;
  mutationsThisSprint: number;
  budgetCentsRemaining: number;
}

export type GovernanceDecision = GovernanceRefusal | GovernanceApproval;

export interface ProposeMutationRequest {
  companyId: string;
  sprintId: string | null;
  proposerAgentId: string | null;
  proposerRole: AgentIdentity["role"] | "pattern_learner" | "system";
  targetSkillRole: AgentIdentity["role"] | string;
  skillContent: string;
  /** Estimated cost of the LLM synthesis for this proposal (cents). */
  estimatedCostCents?: number;
}

/**
 * Decide whether a proposed mutation is allowed under the governance policy.
 * Returns an object the caller can branch on — does NOT throw.
 *
 * The function is side-effect free: counters are NOT incremented here. The
 * caller must call recordMutationProposal() after the mutation is actually
 * stored, to keep dry-runs and simulations accurate.
 */
export async function canProposeMutation(
  req: ProposeMutationRequest,
): Promise<GovernanceDecision> {
  const sprintId = req.sprintId ?? "_no_sprint";
  const budget = getOrInitSprintBudget(sprintId);

  // ── Shell-command lint (applies to every proposal, including system) ──
  const lint = lintSkillContent(req.skillContent);
  if (!lint.clean) {
    auditAgent(
      req.companyId,
      req.proposerRole,
      "mutation_refused",
      `Mutation refused — shell command detected in skill content`,
      {
        severity: "warn",
        detail: {
          code: "shell_command_detected",
          findings: lint.findings,
          targetSkillRole: req.targetSkillRole,
          sprintId,
        },
      },
    );
    return {
      allowed: false,
      reason: `Skill content contains forbidden shell commands: ${lint.findings.join("; ")}`,
      code: "shell_command_detected",
      detail: { findings: lint.findings },
    };
  }

  // ── System/pattern_learner bypass the trust gate + own-role guard ──
  const isSystemProposer =
    req.proposerRole === "pattern_learner" || req.proposerRole === "system";

  // ── Trust gate (skipped for system proposers) ──
  if (!isSystemProposer && req.proposerAgentId) {
    const trust = await cpLoadTrustScore(req.proposerAgentId);
    if (trust.score < MIN_TRUST_FOR_MUTATION) {
      auditAgent(
        req.companyId,
        req.proposerRole,
        "mutation_refused",
        `Mutation refused — trust ${trust.score.toFixed(2)} < ${MIN_TRUST_FOR_MUTATION}`,
        {
          severity: "warn",
          detail: {
            code: "trust_too_low",
            trustScore: trust.score,
            targetSkillRole: req.targetSkillRole,
            sprintId,
          },
        },
      );
      return {
        allowed: false,
        reason: `Agent trust ${trust.score.toFixed(2)} is below required ${MIN_TRUST_FOR_MUTATION}`,
        code: "trust_too_low",
        detail: { trustScore: trust.score, required: MIN_TRUST_FOR_MUTATION },
      };
    }
  }

  // ── Own-role guard (Skills Lead + system bypass per spec §1185) ──
  if (
    !isSystemProposer &&
    req.proposerRole !== "skills_lead" &&
    req.targetSkillRole !== req.proposerRole
  ) {
    auditAgent(
      req.companyId,
      req.proposerRole,
      "mutation_refused",
      `Mutation refused — ${req.proposerRole} cannot mutate ${req.targetSkillRole} skill`,
      {
        severity: "warn",
        detail: {
          code: "cross_role_mutation",
          targetSkillRole: req.targetSkillRole,
          sprintId,
        },
      },
    );
    return {
      allowed: false,
      reason: `${req.proposerRole} can only mutate its own skills; target role is ${req.targetSkillRole}`,
      code: "cross_role_mutation",
      detail: { proposerRole: req.proposerRole, targetSkillRole: req.targetSkillRole },
    };
  }

  // ── Sprint mutation cap ──
  if (budget.mutationCount >= MAX_MUTATIONS_PER_SPRINT) {
    auditSystem(
      req.companyId,
      "mutation_refused",
      `Mutation refused — sprint cap reached (${budget.mutationCount}/${MAX_MUTATIONS_PER_SPRINT})`,
      {
        severity: "warn",
        detail: {
          code: "sprint_cap_exceeded",
          mutationCount: budget.mutationCount,
          cap: MAX_MUTATIONS_PER_SPRINT,
          sprintId,
        },
      },
    );
    return {
      allowed: false,
      reason: `Sprint mutation cap ${MAX_MUTATIONS_PER_SPRINT} reached (${budget.mutationCount} used)`,
      code: "sprint_cap_exceeded",
      detail: {
        mutationCount: budget.mutationCount,
        cap: MAX_MUTATIONS_PER_SPRINT,
        sprintId,
      },
    };
  }

  // ── Per-sprint budget ──
  const estCost = req.estimatedCostCents ?? 0;
  if (budget.budgetCentsSpent + estCost > SPRINT_EVOLUTION_BUDGET_CENTS) {
    auditSystem(
      req.companyId,
      "mutation_refused",
      `Mutation refused — budget would exceed $${(SPRINT_EVOLUTION_BUDGET_CENTS / 100).toFixed(2)}`,
      {
        severity: "warn",
        detail: {
          code: "budget_exceeded",
          budgetCentsSpent: budget.budgetCentsSpent,
          estimatedCostCents: estCost,
          ceiling: SPRINT_EVOLUTION_BUDGET_CENTS,
          sprintId,
        },
      },
    );
    return {
      allowed: false,
      reason: `Sprint evolution budget of $${(SPRINT_EVOLUTION_BUDGET_CENTS / 100).toFixed(2)} would be exceeded`,
      code: "budget_exceeded",
      detail: {
        budgetCentsSpent: budget.budgetCentsSpent,
        estimatedCostCents: estCost,
        ceiling: SPRINT_EVOLUTION_BUDGET_CENTS,
      },
    };
  }

  const trustScore = isSystemProposer || !req.proposerAgentId
    ? 1.0
    : (await cpLoadTrustScore(req.proposerAgentId)).score;

  return {
    allowed: true,
    trustScore,
    mutationsThisSprint: budget.mutationCount,
    budgetCentsRemaining:
      SPRINT_EVOLUTION_BUDGET_CENTS - budget.budgetCentsSpent - estCost,
  };
}

/**
 * Record that a mutation has been successfully proposed. Increments the
 * sprint counters so future canProposeMutation() calls see the usage.
 *
 * Safe to call even without a sprint — uses `_no_sprint` bucket.
 */
export function recordMutationProposal(args: {
  companyId: string;
  sprintId: string | null;
  mutationId: string;
  proposedBy: string;
  costCents: number;
}): void {
  const sprintId = args.sprintId ?? "_no_sprint";
  const budget = getOrInitSprintBudget(sprintId);
  budget.mutationCount += 1;
  budget.budgetCentsSpent += args.costCents;
  budget.proposals.push({
    mutationId: args.mutationId,
    proposedBy: args.proposedBy,
    costCents: args.costCents,
    at: new Date().toISOString(),
  });

  auditSystem(
    args.companyId,
    "mutation_recorded",
    `Mutation ${args.mutationId} proposed by ${args.proposedBy} (${budget.mutationCount}/${MAX_MUTATIONS_PER_SPRINT} this sprint, budget $${(budget.budgetCentsSpent / 100).toFixed(3)}/$${(SPRINT_EVOLUTION_BUDGET_CENTS / 100).toFixed(2)})`,
    {
      severity: "info",
      detail: {
        sprintId,
        mutationId: args.mutationId,
        proposedBy: args.proposedBy,
        costCents: args.costCents,
        mutationCount: budget.mutationCount,
        budgetCentsSpent: budget.budgetCentsSpent,
      },
    },
  );
}

/**
 * Query aggregate stats across all sprints (for the /api/governance endpoint).
 */
export function getAllSprintBudgets(): Readonly<SprintBudgetRecord>[] {
  return [...sprintBudgets.values()].map((b) => ({ ...b }));
}

// ── Post-hoc gate (applied after an LLM produces a mutation) ──

/**
 * Enforce governance on a mutation that has already been stored by the
 * company-runtime (skill-mutator / pattern-learner).
 *
 * This runs *after* the LLM has produced skill content — which means we can
 * now shell-lint the real body. If the gate rejects, we flip the mutation's
 * status to "rejected" so the ATA pipeline won't pick it up.
 *
 * Returns the governance decision so the caller can branch on the outcome
 * (e.g. skip runATAPipeline, log audit entry, inform the Skills Lead).
 */
export async function applyGovernanceToMutation(args: {
  mutation: SkillMutation;
  companyId: string;
  sprintId: string | null;
  proposerAgentId: string | null;
  proposerRole: AgentIdentity["role"] | "pattern_learner" | "system";
  estimatedCostCents: number;
}): Promise<GovernanceDecision> {
  const decision = await canProposeMutation({
    companyId: args.companyId,
    sprintId: args.sprintId,
    proposerAgentId: args.proposerAgentId,
    proposerRole: args.proposerRole,
    targetSkillRole: args.mutation.proposedSkill.role,
    skillContent: args.mutation.proposedSkill.content,
    estimatedCostCents: args.estimatedCostCents,
  });

  if (!decision.allowed) {
    // Flip the mutation to rejected so ATA doesn't pick it up.
    updateMutationStatus(args.mutation.id, "rejected", {
      reviewFeedback: `Governance refusal (${decision.code}): ${decision.reason}`,
    });
    return decision;
  }

  // Approved — record in per-sprint ledger for subsequent checks.
  recordMutationProposal({
    companyId: args.companyId,
    sprintId: args.sprintId,
    mutationId: args.mutation.id,
    proposedBy: args.proposerRole,
    costCents: args.estimatedCostCents,
  });

  return decision;
}
