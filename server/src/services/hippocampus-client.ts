/**
 * Hippocampus Memory Client — calls the Python sidecar API.
 *
 * For local dev without Docker, set HIPPOCAMPUS_API_URL=http://localhost:8100
 */

const HIPPOCAMPUS_URL = process.env.HIPPOCAMPUS_API_URL ?? "http://localhost:8100";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HIPPOCAMPUS_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hippocampus ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${HIPPOCAMPUS_URL}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hippocampus ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/* ---- Types ---- */

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

/* ---- Client ---- */

export const hippocampusClient = {
  /** Store a memory (static or dynamic). */
  async remember(agentId: string, content: string, container = "default", memoryType = "dynamic") {
    return post<{ id: string; content: string; memory_type: string; confidence: number }>(
      "/remember",
      { agent_id: agentId, content, container, memory_type: memoryType },
    );
  },

  /** Recall memories relevant to a query (MMR-ranked). */
  async recall(agentId: string, query: string, container = "default", topK = 10) {
    return post<{ items: MemoryItem[] }>("/recall", {
      agent_id: agentId,
      query,
      container,
      top_k: topK,
      include_graph: true,
    });
  },

  /** Extract facts from conversation messages. */
  async extract(agentId: string, messages: Array<{ role: string; content: string }>, container = "default") {
    return post<ExtractResult>("/extract", {
      agent_id: agentId,
      messages,
      container,
      mode: "agent",
    });
  },

  /** Process a task trajectory (judge→distill→pattern→habit→priming). */
  async processTrajectory(
    agentId: string,
    taskId: string,
    outcome: string,
    quality: number,
    steps: Array<{ action: string; result: string; reasoning?: string }> = [],
    container = "default",
  ) {
    return post<{
      verdict: Record<string, unknown> | null;
      distilled: Record<string, unknown> | null;
      pattern: Record<string, unknown> | null;
      habit: Record<string, unknown> | null;
    }>("/trajectory", {
      agent_id: agentId,
      task_id: taskId,
      outcome,
      quality,
      steps,
      container,
    });
  },

  /** Get the priming prompt for an agent. */
  async getPriming(agentId: string) {
    return get<{ prompt: string }>(`/agents/${agentId}/priming`);
  },

  /** Get habits matching a context query. */
  async getHabits(agentId: string, context = "") {
    const params = context ? `?context=${encodeURIComponent(context)}` : "";
    return get<{ habits: HabitItem[] }>(`/agents/${agentId}/habits${params}`);
  },

  /** Get the full memory summary for an agent. */
  async getSummary(agentId: string) {
    return get<MemorySummary>(`/agents/${agentId}/summary`);
  },

  /** List raw memories for the UI panel. */
  async listMemories(agentId: string, memoryType?: string, container?: string, limit = 50) {
    const params = new URLSearchParams();
    if (memoryType) params.set("memory_type", memoryType);
    if (container) params.set("container", container);
    params.set("limit", String(limit));
    return get<{ items: MemoryListItem[]; total: number }>(
      `/agents/${agentId}/memories?${params.toString()}`,
    );
  },

  /** Trigger garbage collection. */
  async runGC(agentId: string) {
    return post<{ expired: number; decayed: number; demoted: number }>(
      `/agents/${agentId}/gc`,
      {},
    );
  },

  /** Run memory promotion cycle. */
  async runPromotions(agentId: string) {
    return post<{ promotions: Array<{ memory_id: string; from_tier: string; to_tier: string; reason: string }> }>(
      `/agents/${agentId}/promotions`,
      {},
    );
  },

  /** Health check. */
  async health() {
    return get<{ status: string; agents_loaded: number; debug: boolean }>("/health");
  },
};
