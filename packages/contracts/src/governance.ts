/**
 * @module governance
 * Policy rules, trust scores, and violation tracking schemas.
 *
 * The governance layer gates every tool call through policy rules.
 * Each agent has a trust score (0–1) that rises/falls based on outcomes.
 * Rules match by role, tool pattern, trust threshold, and file patterns.
 *
 * Key types:
 * - PolicyRule — a governance rule with role/tool matching and decision
 * - PolicyEvalContext — input to the governance gateway for a single tool call
 * - PolicyDecision — the gateway's allow/deny/escalate verdict
 * - TrustScore — per-agent trust with delta history
 * - PolicyViolation — recorded when a rule fires
 */
import { z } from "zod";

import { roleTypeSchema } from "./agents";

export const policyDecisionKindSchema = z.enum(["allow", "deny", "escalate"]);

export const policyRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Which roles this rule applies to; empty = all */
  appliesTo: z.array(roleTypeSchema).default([]),
  /** Tool name patterns this rule governs (glob-like, e.g. "file_*") */
  toolPatterns: z.array(z.string()).default([]),
  /** Minimum trust score required; below this the rule fires */
  minTrust: z.number().min(0).max(1).default(0),
  /** What happens when the rule fires */
  decision: policyDecisionKindSchema,
  /** If true, rule is currently active */
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  /** Optional regex pattern for file-path enforcement (e.g. "\\.(test|spec)\\.") */
  filePattern: z.string().optional(),
});

export const policyEvalContextSchema = z.object({
  agentId: z.string(),
  role: roleTypeSchema,
  tool: z.string(),
  trustScore: z.number().min(0).max(1),
  beatId: z.string().optional(),
  companyId: z.string(),
  /** File path being accessed — used for file-pattern rules (Spec 21) */
  filePath: z.string().optional(),
});

export const policyDecisionSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  decision: policyDecisionKindSchema,
  reason: z.string(),
  evaluatedAt: z.string(),
});

export const trustScoreSchema = z.object({
  agentId: z.string(),
  score: z.number().min(0).max(1),
  history: z.array(z.object({
    delta: z.number(),
    reason: z.string(),
    timestamp: z.string(),
  })).default([]),
  updatedAt: z.string(),
});

export const trustEventKindSchema = z.enum([
  "task_completed",
  "task_failed",
  "violation",
  "escalation_resolved",
  "manual_adjustment",
]);

export const trustEventSchema = z.object({
  agentId: z.string(),
  kind: trustEventKindSchema,
  delta: z.number(),
  reason: z.string(),
  timestamp: z.string(),
});

export const policySeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const policyViolationSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  /** Null for system-scoped denies (no agent owns the call). */
  agentId: z.string().nullable(),
  ruleId: z.string(),
  tool: z.string(),
  decision: policyDecisionKindSchema,
  severity: policySeveritySchema,
  detail: z.string(),
  beatId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type PolicyDecisionKind = z.infer<typeof policyDecisionKindSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type PolicyEvalContext = z.infer<typeof policyEvalContextSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type TrustScore = z.infer<typeof trustScoreSchema>;
export type TrustEventKind = z.infer<typeof trustEventKindSchema>;
export type TrustEvent = z.infer<typeof trustEventSchema>;
export type PolicySeverity = z.infer<typeof policySeveritySchema>;
export type PolicyViolation = z.infer<typeof policyViolationSchema>;
