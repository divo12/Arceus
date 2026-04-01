export const MEMORY_TIERS = ["static", "dynamic", "working"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_VISIBILITIES = [
  "private",
  "task_scoped",
  "startup_shared",
  "board_visible",
] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_PROMOTION_STATUSES = [
  "pending",
  "promoted",
  "declined",
  "expired",
] as const;
export type MemoryPromotionStatus = (typeof MEMORY_PROMOTION_STATUSES)[number];

export const INITIAL_PRIMING_STATE = {
  confidence: 0.5,
  caution: 0.5,
  morale: 0.7,
  recentEvents: [] as string[],
} as const;

export interface MemoryItem {
  id: string;
  agentId: string;
  companyId: string;
  content: string;
  memoryType: MemoryTier;
  confidence: number;
  container: string;
  visibility: MemoryVisibility;
  sourceType: string | null;
  sourceId: string | null;
  version: number;
  previousVersionId: string | null;
  promotionStatus: MemoryPromotionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryHabit {
  id: string;
  agentId: string;
  triggerCondition: string;
  action: string;
  confidence: number;
  usageCount: number;
  isActive: boolean;
}

export interface MemoryPrimingState {
  confidence: number;
  caution: number;
  morale: number;
  recentEvents: string[];
}

export interface MemoryScope {
  companyId: string;
  agentId?: string;
  container?: string;
  memoryType?: MemoryTier;
}

export interface MemoryUsage {
  operationType: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  success: boolean;
  error?: string;
}
