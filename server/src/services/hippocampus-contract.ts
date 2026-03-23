export type HippocampusMode = "off" | "embedded" | "sidecar";

export interface MemoryItem {
  id: string;
  content: string;
  memory_type: string | null;
  confidence: number | null;
  relevance_score: number | null;
  kind: string;
}

export interface MemorySummary {
  total_static: number;
  total_dynamic: number;
  active_habits: Array<{ trigger: string; action: string; confidence: number }>;
  priming_prompt: string;
  graph_node_count: number;
  top_patterns?: Array<Record<string, unknown>>;
  current_state?: Record<string, unknown>;
  recent_learnings?: string[];
  recent_promotions?: string[];
  generated_at?: string;
}

export interface MemoryListItem {
  id: string;
  content: string;
  memory_type: string | null;
  confidence: number;
  relevance_score: number;
  container: string;
  visibility: string | null;
  created_at: string | null;
  updated_at: string | null;
  access_count: number;
}

export interface ExtractResult {
  added: number;
  updated: number;
  deleted: number;
}

export interface HabitItem {
  trigger: string;
  action: string;
  confidence: number;
}

export interface PromotionItem {
  memory_id: string;
  from_tier: string;
  to_tier: string;
  reason: string;
}

export interface HealthResult {
  status: string;
  agents_loaded: number;
  debug: boolean;
  diagnostics?: HippocampusRuntimeDiagnostics | null;
}

export interface HippocampusRuntimeDiagnostics {
  mode: HippocampusMode;
  status: "stopped" | "starting" | "running" | "stopping" | "crashed" | "backoff";
  pid: number | null;
  pendingRequests: number;
  consecutiveCrashes: number;
  totalCrashes: number;
  lastCrashAt: number | null;
  nextRestartAt: number | null;
  stderrExcerpt: string;
}

export interface HippocampusBridge {
  readonly mode: HippocampusMode;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  health(): Promise<HealthResult>;
  remember(agentId: string, content: string, container?: string, memoryType?: string): Promise<{
    id: string;
    content: string;
    memory_type: string;
    confidence: number;
  }>;
  recall(agentId: string, query: string, container?: string, topK?: number): Promise<{ items: MemoryItem[] }>;
  extract(
    agentId: string,
    messages: Array<{ role: string; content: string }>,
    container?: string,
  ): Promise<ExtractResult>;
  processTrajectory(
    agentId: string,
    taskId: string,
    outcome: string,
    quality: number,
    steps?: Array<{ action: string; result: string; reasoning?: string }>,
    container?: string,
  ): Promise<{
    verdict: Record<string, unknown> | null;
    distilled: Record<string, unknown> | null;
    pattern: Record<string, unknown> | null;
    habit: Record<string, unknown> | null;
  }>;
  getPriming(agentId: string): Promise<{ prompt: string }>;
  getHabits(agentId: string, context?: string): Promise<{ habits: HabitItem[] }>;
  getSummary(agentId: string): Promise<MemorySummary>;
  listMemories(
    agentId: string,
    memoryType?: string,
    container?: string,
    limit?: number,
  ): Promise<{ items: MemoryListItem[]; total: number }>;
  runGC(agentId: string): Promise<{ expired: number; decayed: number; demoted: number }>;
  runPromotions(agentId: string): Promise<{ promotions: PromotionItem[] }>;
  close(): Promise<void>;
  diagnostics?(): HippocampusRuntimeDiagnostics | null;
}

export class HippocampusDisabledError extends Error {
  constructor(message = "Hippocampus is disabled") {
    super(message);
    this.name = "HippocampusDisabledError";
  }
}

export class HippocampusUnavailableError extends Error {
  constructor(message = "Hippocampus runtime is unavailable") {
    super(message);
    this.name = "HippocampusUnavailableError";
  }
}

export class HippocampusTimeoutError extends Error {
  constructor(message = "Hippocampus request timed out") {
    super(message);
    this.name = "HippocampusTimeoutError";
  }
}
