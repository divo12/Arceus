import { z } from "zod";

export const memoryUnitTypeSchema = z.enum(["static", "dynamic", "episodic", "semantic", "delegation"]);
export const memoryVisibilitySchema = z.enum(["public", "team", "private"]);
export const memorySourceSchema = z.enum(["role_seed", "task_completion", "meeting", "chat", "delegation", "system"]);
export const habitStatusSchema = z.enum(["draft", "active", "inactive"]);

export const memorySummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  currentFocus: z.array(z.string()),
  recentLearnings: z.array(z.string()),
  activePatterns: z.array(z.string()),
  openBlockers: z.array(z.string()),
  importantDecisions: z.array(z.string()),
  updatedAt: z.string()
});

export const memoryUnitSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  sourceTaskId: z.string().nullable(),
  sourceArtifactId: z.string().nullable(),
  type: memoryUnitTypeSchema,
  visibility: memoryVisibilitySchema,
  source: memorySourceSchema,
  content: z.string(),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable()
});

export const habitSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  name: z.string(),
  description: z.string(),
  trigger: z.string(),
  action: z.string(),
  status: habitStatusSchema,
  usageCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const primingStateSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  confidence: z.number().min(0).max(1),
  caution: z.number().min(0).max(1),
  morale: z.number().min(0).max(1),
  lastDisposition: z.string(),
  recentEvents: z.array(z.string()),
  updatedAt: z.string()
});

export type MemorySummary = z.infer<typeof memorySummarySchema>;
export type MemoryUnit = z.infer<typeof memoryUnitSchema>;
export type Habit = z.infer<typeof habitSchema>;
export type PrimingState = z.infer<typeof primingStateSchema>;
