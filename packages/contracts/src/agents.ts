/**
 * @module agents
 * Agent identity and session schemas.
 *
 * Defines the org-chart structure: each agent occupies a HierarchyNode,
 * has an AgentIdentity (with role, capabilities, soul), and binds to an
 * LLM session via SessionBinding.
 *
 * Key types:
 * - RoleSoul — per-role personality, permissions, and system prompt
 * - HierarchyNode — position in the org chart (parent/children)
 * - AgentIdentity — runtime identity of a hired agent
 * - SessionBinding — link between agent and its OpenCode LLM session
 */
import { z } from "zod";

export const agentStatusSchema = z.enum(["active", "idle", "running", "error", "paused", "terminated"]);
export const roleTypeSchema = z.enum(["ceo", "cto", "pm", "developer", "senior_developer", "tester", "ui_designer", "marketing", "skills_lead"]);

export const roleSoulSchema = z.object({
  role: roleTypeSchema,
  purpose: z.string(),
  systemPrompt: z.string(),
  canWriteCode: z.boolean(),
  canEditFiles: z.boolean(),
  canRunShell: z.boolean(),
  canApproveStrategy: z.boolean(),
  canRequestHiring: z.boolean(),
  allowedDirectReports: z.array(roleTypeSchema),
  defaultCapabilities: z.array(z.string())
});

export const hierarchyNodeSchema = z.object({
  id: z.string(),
  role: roleTypeSchema,
  title: z.string(),
  level: z.number().int().nonnegative(),
  parentNodeId: z.string().nullable(),
  agentId: z.string().nullable(),
  directReportNodeIds: z.array(z.string()),
  openForHiring: z.boolean()
});

export const agentIdentitySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  nodeId: z.string(),
  name: z.string(),
  role: roleTypeSchema,
  title: z.string(),
  managerAgentId: z.string().nullable(),
  reportAgentIds: z.array(z.string()),
  capabilities: z.array(z.string()),
  profile: z.string(),
  soul: roleSoulSchema,
  status: agentStatusSchema,
  sessionBindingId: z.string(),
  memorySummaryId: z.string(),
  lastHeartbeatAt: z.string().nullable()
});

export const sessionBindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  runtime: z.literal("opencode"),
  sessionId: z.string(),
  runtimeStatus: z.enum(["connected", "idle", "disconnected"]),
  model: z.string(),
  lastSeenAt: z.string()
});

export type RoleSoul = z.infer<typeof roleSoulSchema>;
export type RoleType = z.infer<typeof roleTypeSchema>;
export type HierarchyNode = z.infer<typeof hierarchyNodeSchema>;
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type SessionBinding = z.infer<typeof sessionBindingSchema>;

/**
 * Validate a runtime value (DB row, env var, HTTP body) is a valid RoleType.
 * Returns the typed role on match, `null` on any other input. Use this at
 * untrusted boundaries instead of `value as RoleType` — the cast silently
 * propagates stale values if the schema enum changes; this surfaces them.
 *
 * Audit C11 (F-098 family): replaces ~15 `as AgentIdentity["role"]` /
 * `as RoleType` casts that bypass validation.
 */
export function parseRole(value: unknown): RoleType | null {
  const result = roleTypeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Like {@link parseRole} but throws on miss. Use when the value is
 * trusted-by-construction (e.g. hard-coded literals, values you just
 * pulled from a previously-validated record) and a stale string would be
 * a programmer error worth crashing on.
 */
export function parseRoleStrict(value: unknown): RoleType {
  return roleTypeSchema.parse(value);
}

/** Filter an array of strings down to those that parse as valid RoleTypes. */
export function filterValidRoles(values: readonly unknown[]): RoleType[] {
  const out: RoleType[] = [];
  for (const v of values) {
    const r = parseRole(v);
    if (r !== null) out.push(r);
  }
  return out;
}
