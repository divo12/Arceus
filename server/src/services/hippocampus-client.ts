/**
 * Hippocampus sidecar bridge.
 *
 * This preserves the legacy HTTP integration path as a reference/parity
 * implementation while the embedded stdio runtime is rolled out.
 */

import type {
  ExtractResult,
  HabitItem,
  HealthResult,
  HippocampusBridge,
  MemoryItem,
  MemoryListItem,
  MemorySummary,
  PromotionItem,
} from "./hippocampus-contract.js";

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
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

async function get<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hippocampus ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export function createSidecarHippocampusBridge(baseUrl: string): HippocampusBridge {
  return {
    mode: "sidecar",

    async remember(agentId: string, content: string, container = "default", memoryType = "dynamic") {
      return post<{ id: string; content: string; memory_type: string; confidence: number }>(
        baseUrl,
        "/remember",
        { agent_id: agentId, content, container, memory_type: memoryType },
      );
    },

    async recall(agentId: string, query: string, container = "default", topK = 10) {
      return post<{ items: MemoryItem[] }>(baseUrl, "/recall", {
        agent_id: agentId,
        query,
        container,
        top_k: topK,
        include_graph: true,
      });
    },

    async extract(agentId: string, messages: Array<{ role: string; content: string }>, container = "default") {
      return post<ExtractResult>(baseUrl, "/extract", {
        agent_id: agentId,
        messages,
        container,
        mode: "agent",
      });
    },

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
      }>(baseUrl, "/trajectory", {
        agent_id: agentId,
        task_id: taskId,
        outcome,
        quality,
        steps,
        container,
      });
    },

    async getPriming(agentId: string) {
      return get<{ prompt: string }>(baseUrl, `/agents/${agentId}/priming`);
    },

    async getHabits(agentId: string, context = "") {
      const params = context ? `?context=${encodeURIComponent(context)}` : "";
      return get<{ habits: HabitItem[] }>(baseUrl, `/agents/${agentId}/habits${params}`);
    },

    async getSummary(agentId: string) {
      return get<MemorySummary>(baseUrl, `/agents/${agentId}/summary`);
    },

    async listMemories(agentId: string, memoryType?: string, container?: string, limit = 50) {
      const params = new URLSearchParams();
      if (memoryType) params.set("memory_type", memoryType);
      if (container) params.set("container", container);
      params.set("limit", String(limit));
      return get<{ items: MemoryListItem[]; total: number }>(
        baseUrl,
        `/agents/${agentId}/memories?${params.toString()}`,
      );
    },

    async runGC(agentId: string) {
      return post<{ expired: number; decayed: number; demoted: number }>(
        baseUrl,
        `/agents/${agentId}/gc`,
        {},
      );
    },

    async runPromotions(agentId: string) {
      return post<{ promotions: PromotionItem[] }>(
        baseUrl,
        `/agents/${agentId}/promotions`,
        {},
      );
    },

    async health() {
      return get<HealthResult>(baseUrl, "/health");
    },

    async close() {
      return;
    },

    diagnostics() {
      return null;
    },
  };
}

const defaultBaseUrl = process.env.HIPPOCAMPUS_API_URL ?? "http://localhost:8100";

// Legacy export kept temporarily as a reference implementation.
export const hippocampusClient = createSidecarHippocampusBridge(defaultBaseUrl);
