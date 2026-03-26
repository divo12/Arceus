import { ApiError, api } from "./client";

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

export interface GraphNode {
  id: string;
  name: string;
  entity_type: string;
  mention_count: number;
  created_at?: string;
  content?: string;
  confidence?: number | null;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
}

export interface GraphMemoryView {
  center_node: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
}

export interface PromotionEvent {
  agent_id: string;
  memory_id: string;
  from_type: string;
  to_type: string;
  reason: string;
  status: string;
  timestamp: string;
  content?: string;
}

export interface RecallItem {
  id: string;
  content: string;
  memory_type: string | null;
  confidence: number | null;
  relevance_score: number | null;
  kind: string;
}

export interface ScopedRecallParams {
  query: string;
  startupId: string;
  employeeId: string;
  taskId?: string;
  includeShared?: boolean;
  topK?: number;
}

export interface ShareableMemoryParams {
  startupId: string;
  visibility?: Array<"shared" | "board" | "private" | "task_scoped">;
}

export interface MemoryHealth {
  status: string;
  agents_loaded: number;
  debug: boolean;
  diagnostics?: {
    mode: "off" | "embedded" | "sidecar";
    status: "stopped" | "starting" | "running" | "stopping" | "crashed" | "backoff";
    pid: number | null;
    pendingRequests: number;
    consecutiveCrashes: number;
    totalCrashes: number;
    lastCrashAt: number | null;
    nextRestartAt: number | null;
    stderrExcerpt: string;
  } | null;
}

export interface PromotionRunItem {
  memory_id: string;
  from_tier: string;
  to_tier: string;
  reason: string;
}

function buildQuery(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  return query.toString();
}

function normalizeGraphNode(input: unknown): GraphNode {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    id: String(value.id ?? ""),
    name: String(value.name ?? value.content ?? value.id ?? "Unknown"),
    entity_type: String(value.entity_type ?? value.entityType ?? "memory"),
    mention_count:
      typeof value.mention_count === "number"
        ? value.mention_count
        : typeof value.mentionCount === "number"
          ? value.mentionCount
          : 1,
    created_at:
      typeof value.created_at === "string"
        ? value.created_at
        : typeof value.createdAt === "string"
          ? value.createdAt
          : undefined,
    content: typeof value.content === "string" ? value.content : undefined,
    confidence: typeof value.confidence === "number" ? value.confidence : null,
  };
}

function normalizeGraphEdge(input: unknown): GraphEdge {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    source_id: String(value.source_id ?? value.sourceId ?? ""),
    target_id: String(value.target_id ?? value.targetId ?? ""),
    relation_type: String(value.relation_type ?? value.relationType ?? "related_to"),
    weight:
      typeof value.weight === "number"
        ? value.weight
        : typeof value.score === "number"
          ? value.score
          : 1,
  };
}

function normalizeGraphView(input: unknown): GraphMemoryView {
  const value = (input ?? {}) as Record<string, unknown>;
  const nodes = Array.isArray(value.nodes) ? value.nodes.map(normalizeGraphNode) : [];
  return {
    center_node: value.center_node ? normalizeGraphNode(value.center_node) : null,
    nodes,
    edges: Array.isArray(value.edges) ? value.edges.map(normalizeGraphEdge) : [],
    depth: typeof value.depth === "number" ? value.depth : 2,
  };
}

function normalizePromotionEvent(
  input: unknown,
  agentId: string,
  fallbackTimestamp: string,
): PromotionEvent {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    agent_id: String(value.agent_id ?? value.agentId ?? agentId),
    memory_id: String(value.memory_id ?? value.memoryId ?? ""),
    from_type: String(value.from_type ?? value.from_tier ?? value.fromType ?? "dynamic"),
    to_type: String(value.to_type ?? value.to_tier ?? value.toType ?? "static"),
    reason: String(value.reason ?? "confidence threshold"),
    status: String(value.status ?? "completed"),
    timestamp: String(value.timestamp ?? value.created_at ?? value.createdAt ?? fallbackTimestamp),
    content: typeof value.content === "string" ? value.content : undefined,
  };
}

export const memoryApi = {
  summary: (agentId: string) =>
    api.get<MemorySummary>(`/agents/${agentId}/memory/summary`),

  list: (agentId: string, memoryType?: string, container?: string, limit = 50) => {
    const params = buildQuery({
      memory_type: memoryType,
      container,
      limit,
    });
    return api.get<{ items: MemoryListItem[]; total: number }>(
      `/agents/${agentId}/memory/list?${params}`,
    );
  },

  priming: (agentId: string) =>
    api.get<{ prompt: string }>(`/agents/${agentId}/memory/priming`),

  habits: (agentId: string, context = "") => {
    const params = context ? `?context=${encodeURIComponent(context)}` : "";
    return api.get<{ habits: Array<{ trigger: string; action: string; confidence: number }> }>(
      `/agents/${agentId}/memory/habits${params}`
    );
  },

  remember: (agentId: string, content: string, container = "default", memoryType = "dynamic") =>
    api.post<{ id: string; content: string; memory_type: string; confidence: number }>(
      `/agents/${agentId}/memory/remember`,
      { content, container, memory_type: memoryType },
    ),

  recall: (agentId: string, query: string, container = "default", topK = 10) =>
    api.post<{ items: RecallItem[] }>(
      `/agents/${agentId}/memory/recall`,
      { query, container, top_k: topK },
    ),

  scopedRecall: (agentId: string, params: ScopedRecallParams) =>
    api.post<{ items: RecallItem[]; total: number }>(
      `/agents/${agentId}/memory/scoped-recall`,
      {
        query: params.query,
        startupId: params.startupId,
        employeeId: params.employeeId,
        taskId: params.taskId,
        includeShared: params.includeShared ?? true,
        topK: params.topK ?? 10,
      },
    ),

  getShareable: (agentId: string, params: ShareableMemoryParams) => {
    const query = new URLSearchParams({ startupId: params.startupId });
    if (params.visibility?.length) {
      query.set("visibility", params.visibility.join(","));
    }
    return api.get<{ items: MemoryListItem[]; total: number }>(
      `/agents/${agentId}/memory/shareable?${query.toString()}`,
    );
  },

  gc: (agentId: string) =>
    api.post<{ expired: number; decayed: number; demoted: number }>(
      `/agents/${agentId}/memory/gc`,
      {},
    ),

  runPromotions: (agentId: string) =>
    api.post<{ promotions: PromotionRunItem[] }>(
      `/agents/${agentId}/memory/promotions`,
      {},
    ),

  graphView: async (agentId: string, query: string, container?: string, depth = 2) => {
    const params = buildQuery({ query, container, depth });
    const result = await api.get<unknown>(`/agents/${agentId}/memory/graph?${params}`);
    return normalizeGraphView(result);
  },

  versionHistory: async (agentId: string, memoryId: string) => {
    const result = await api.get<unknown>(`/agents/${agentId}/memory/${memoryId}/history`);
    if (Array.isArray(result)) {
      return result.map(normalizeGraphNode);
    }
    const payload = result as Record<string, unknown>;
    const versions = Array.isArray(payload.versions) ? payload.versions : [];
    return versions.map(normalizeGraphNode);
  },

  promotionLog: async (agentId: string, limit = 20) => {
    const params = buildQuery({ limit });
    const result = await api.get<unknown>(`/agents/${agentId}/memory/promotions?${params}`);
    const nowIso = new Date().toISOString();
    if (Array.isArray(result)) {
      return result.map((item) => normalizePromotionEvent(item, agentId, nowIso));
    }
    const payload = result as Record<string, unknown>;
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.promotions)
        ? payload.promotions
        : [];
    return items.map((item) => normalizePromotionEvent(item, agentId, nowIso));
  },

  memoryExplorer: async (agentId: string, container: string, memoryType?: string, limit = 50) => {
    const params = buildQuery({
      container,
      memory_type: memoryType,
      limit,
    });
    try {
      return await api.get<{ items: MemoryListItem[]; total: number }>(
        `/agents/${agentId}/memory/explorer?${params}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return memoryApi.list(agentId, memoryType, container, limit);
      }
      throw error;
    }
  },

  health: () => api.get<MemoryHealth>("/memory/health"),
};
