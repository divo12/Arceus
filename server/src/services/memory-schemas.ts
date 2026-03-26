import { z } from "zod";

export const ScopedRecallSchema = z.object({
  query: z.string().min(1).max(2000),
  startupId: z.string().min(1),
  employeeId: z.string().min(1),
  taskId: z.string().optional(),
  includeShared: z.boolean().default(true),
  topK: z.number().int().min(1).max(100).default(10),
});

export const DelegateSchema = z.object({
  toAgentId: z.string().min(1),
  startupId: z.string().min(1),
  taskId: z.string().min(1),
  taskDescription: z.string().min(1).max(5000),
  topK: z.number().int().min(1).max(50).default(10),
});

export const InternalizeDelegationSchema = z.object({
  startupId: z.string().min(1),
  learnings: z.array(z.string().min(1).max(5000)).min(1).max(50),
  quality: z.number().min(0).max(1),
});

export const GraphQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  container: z.string().default("default"),
  depth: z.coerce.number().int().min(1).max(5).default(2),
});

export const MemoryHistoryParamsSchema = z.object({
  memoryId: z.string().min(1),
});

export const MemoryExplorerQuerySchema = z.object({
  container: z.string().min(1),
  memory_type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const PromotionLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const ProfileQuerySchema = z.object({
  startupId: z.string().min(1),
  role: z.string().min(1).max(200),
});

export const MeetingExtractSchema = z.object({
  meetingId: z.string().min(1),
  transcript: z.string().min(1).max(100_000),
  participants: z.array(z.string().min(1)).min(1).max(50),
});
