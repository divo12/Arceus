import { api } from "./client";

export interface MemorySummary {
  total_static: number;
  total_dynamic: number;
  active_habits: Array<{ trigger: string; action: string; confidence: number }>;
  priming_prompt: string;
  graph_node_count: number;
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

export interface RecallItem {
  id: string;
  content: string;
  memory_type: string | null;
  confidence: number | null;
  relevance_score: number | null;
  kind: string;
}

export interface MemoryHealth {
  status: string;
  agents_loaded: number;
  debug: boolean;
}

export const memoryApi = {
  summary: (agentId: string) =>
    api.get<MemorySummary>(`/agents/${agentId}/memory/summary`),

  list: (agentId: string, memoryType?: string, container?: string, limit = 50) => {
    const params = new URLSearchParams();
    if (memoryType) params.set("memory_type", memoryType);
    if (container) params.set("container", container);
    params.set("limit", String(limit));
    return api.get<{ items: MemoryListItem[]; total: number }>(
      `/agents/${agentId}/memory/list?${params.toString()}`
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

  gc: (agentId: string) =>
    api.post<{ expired: number; decayed: number; demoted: number }>(
      `/agents/${agentId}/memory/gc`,
      {},
    ),

  health: () => api.get<MemoryHealth>("/memory/health"),
};
