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
export const roleTypeSchema = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);

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
export type HierarchyNode = z.infer<typeof hierarchyNodeSchema>;
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
