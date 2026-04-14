/**
 * Spec 13 – Step 5: Policy Evaluation Engine (Governance Gateway)
 *
 * Pure, deterministic policy enforcement. No I/O — the caller provides
 * context and rules; the gateway returns decisions.
 *
 * Two main entry points:
 *   1. evaluatePolicy()      – evaluate a single tool access request
 *   2. filterToolsForAgent() – pre-compute which tools an agent may see
 *
 * Default policy: ALLOW (only explicit rules deny or escalate).
 */

import type {
  PolicyRule,
  PolicyDecision,
  PolicyEvalContext,
  PolicyDecisionKind,
  RoleSoul,
} from "@arceus/contracts";
import { getTrustTier, type TrustTier } from "./trust-factor";

// ── Pattern matching ────────────────────────────────────────

/**
 * Match a tool name against a pattern.
 * Supports:
 *   - exact match: "bash" matches "bash"
 *   - wildcard:    "*" matches everything
 *   - prefix:      "file_*" matches "file_read", "file_write"
 */
function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/** Check if a rule applies to a given role. Empty appliesTo = all roles. */
function ruleAppliesToRole(rule: PolicyRule, role: RoleSoul["role"]): boolean {
  return rule.appliesTo.length === 0 || rule.appliesTo.includes(role);
}

/** Check if a rule matches a specific tool name via its patterns. */
function ruleMatchesTool(rule: PolicyRule, toolName: string): boolean {
  if (rule.toolPatterns.length === 0) return true;  // no patterns = matches all
  return rule.toolPatterns.some((p) => matchToolPattern(p, toolName));
}

/** Check if a trust-gated rule fires (agent trust < rule minTrust). */
function ruleTrustGateFires(rule: PolicyRule, trustScore: number): boolean {
  // If minTrust is 0, the rule doesn't have a trust gate — it always fires on match.
  if (rule.minTrust === 0) return true;
  // Rule fires when the agent's trust is BELOW the threshold.
  return trustScore < rule.minTrust;
}

// ── Core evaluation ─────────────────────────────────────────

/**
 * Evaluate a single tool access request against the rule set.
 *
 * Rules are evaluated in priority order (highest first). The first matching
 * rule that applies to the agent's role and tool determines the decision.
 * If no rule matches, the default is ALLOW.
 *
 * @param ctx   - The evaluation context (agent, tool, trust, etc.)
 * @param rules - Sorted policy rules (highest priority first)
 * @returns The policy decision with the matched rule, or a default ALLOW.
 */
export function evaluatePolicy(
  ctx: PolicyEvalContext,
  rules: PolicyRule[],
): PolicyDecision {
  const now = new Date().toISOString();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleAppliesToRole(rule, ctx.role)) continue;
    if (!ruleMatchesTool(rule, ctx.tool)) continue;
    if (!ruleTrustGateFires(rule, ctx.trustScore)) continue;

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      decision: rule.decision,
      reason: `Rule "${rule.name}" matched tool "${ctx.tool}" for role ${ctx.role} (trust=${ctx.trustScore.toFixed(2)}, minTrust=${rule.minTrust})`,
      evaluatedAt: now,
    };
  }

  // Default: ALLOW
  return {
    ruleId: "default-allow",
    ruleName: "Default Allow",
    decision: "allow",
    reason: `No rule matched tool "${ctx.tool}" for role ${ctx.role} — default ALLOW`,
    evaluatedAt: now,
  };
}

/**
 * Pre-filter a set of tool names for an agent. Returns only the tools
 * that the agent is allowed to use (decision = "allow").
 *
 * Tools with "deny" or "escalate" decisions are removed from the set so
 * the LLM session never sees them.
 *
 * @param role       - The agent's role
 * @param trustScore - The agent's current trust score
 * @param toolNames  - All candidate tool names
 * @param rules      - Sorted policy rules
 * @param companyId  - Company ID for context
 * @param agentId    - Agent ID for context
 * @param beatId     - Optional beat ID for context
 * @returns Object with allowed tools and detailed evaluation log
 */
export function filterToolsForAgent(
  role: RoleSoul["role"],
  trustScore: number,
  toolNames: string[],
  rules: PolicyRule[],
  companyId: string,
  agentId: string,
  beatId?: string,
): FilterResult {
  const allowed: string[] = [];
  const denied: DeniedTool[] = [];
  const escalated: DeniedTool[] = [];

  for (const tool of toolNames) {
    const ctx: PolicyEvalContext = {
      agentId,
      role,
      tool,
      trustScore,
      companyId,
      beatId,
    };

    const decision = evaluatePolicy(ctx, rules);

    if (decision.decision === "allow") {
      allowed.push(tool);
    } else if (decision.decision === "escalate") {
      escalated.push({ tool, decision });
    } else {
      denied.push({ tool, decision });
    }
  }

  const tier = getTrustTier(trustScore);

  return { allowed, denied, escalated, tier, trustScore };
}

// ── Types ───────────────────────────────────────────────────

export interface DeniedTool {
  tool: string;
  decision: PolicyDecision;
}

export interface FilterResult {
  /** Tools the agent is allowed to use. */
  allowed: string[];
  /** Tools explicitly denied with reasons. */
  denied: DeniedTool[];
  /** Tools needing escalation approval. */
  escalated: DeniedTool[];
  /** The agent's trust tier at evaluation time. */
  tier: TrustTier;
  /** The raw trust score. */
  trustScore: number;
}

/**
 * Convert a FilterResult's allowed list back to the OpenCode tools param format.
 * Returns undefined if the agent has no tools (text-only session).
 */
export function toOpenCodeToolsParam(
  filterResult: FilterResult,
): Record<string, boolean> | undefined {
  if (filterResult.allowed.length === 0) return undefined;
  const param: Record<string, boolean> = {};
  for (const tool of filterResult.allowed) {
    param[tool] = true;
  }
  return param;
}

/**
 * Build a human-readable summary of a filter result for logging.
 */
export function summarizeFilterResult(result: FilterResult, role: string): string {
  const parts = [
    `[Governance] ${role} (trust=${result.trustScore.toFixed(2)}, tier=${result.tier})`,
    `allowed=[${result.allowed.join(",")}]`,
  ];
  if (result.denied.length > 0) {
    parts.push(`denied=[${result.denied.map((d) => `${d.tool}:${d.decision.ruleId}`).join(",")}]`);
  }
  if (result.escalated.length > 0) {
    parts.push(`escalated=[${result.escalated.map((e) => `${e.tool}:${e.decision.ruleId}`).join(",")}]`);
  }
  return parts.join(" ");
}
