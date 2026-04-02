import type { HippocampusBridge, MemoryItem, MemoryListItem } from "./hippocampus-contract.js";
import { logger } from "../middleware/logger.js";

export const MemoryContainers = {
  startup: (startupId: string) => `startup:${startupId}`,
  employee: (startupId: string, employeeId: string) => `startup:${startupId}:emp:${employeeId}`,
  task: (startupId: string, taskId: string) => `startup:${startupId}:task:${taskId}`,
  subAgent: (startupId: string, taskId: string, agentId: string) =>
    `startup:${startupId}:task:${taskId}:sub:${agentId}`,
} as const;

export type MemoryVisibility = "private" | "task_scoped" | "startup_shared" | "board_visible";

const MEMORY_PRIORITY: Record<string, number> = {
  static: 3,
  dynamic: 2,
  working: 1,
};

function logMemoryOp(op: string, agentId: string, extra?: Record<string, unknown>) {
  logger.info({ svc: "memory", op, agentId, ...extra }, "memory scope operation");
}

export class MemoryScopeService {
  constructor(private readonly bridge: HippocampusBridge) {}

  async getMemoriesForAgent(
    agentId: string,
    query: string,
    startupId: string,
    employeeId: string,
    taskId?: string,
    includeShared = true,
    topK = 10,
  ): Promise<MemoryItem[]> {
    const recalls: Array<Promise<{ items: MemoryItem[] }>> = [];

    if (includeShared) {
      recalls.push(this.bridge.recall(agentId, query, MemoryContainers.startup(startupId), topK));
    }
    recalls.push(this.bridge.recall(agentId, query, MemoryContainers.employee(startupId, employeeId), topK));
    if (taskId) {
      recalls.push(this.bridge.recall(agentId, query, MemoryContainers.task(startupId, taskId), topK));
    }

    const settled = await Promise.allSettled(recalls);
    const results: MemoryItem[] = [];

    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(...result.value.items);
      }
    }

    logMemoryOp("scoped-recall", agentId, {
      startupId,
      employeeId,
      taskId: taskId ?? null,
      includeShared,
      topK,
      containers: recalls.length,
      results: results.length,
      rejected: settled.filter((item) => item.status === "rejected").length,
    });

    return this.deduplicateByPriority(results);
  }

  async getShareableMemories(
    agentId: string,
    startupId: string,
    visibility: MemoryVisibility[] = ["startup_shared", "board_visible"],
  ): Promise<MemoryListItem[]> {
    const all = await this.bridge.listMemories(agentId, undefined, MemoryContainers.startup(startupId));
    const filtered = all.items.filter((item) => visibility.includes((item.visibility ?? "private") as MemoryVisibility));

    logMemoryOp("shareable-memories", agentId, {
      startupId,
      visibility,
      total: all.total,
      returned: filtered.length,
    });

    return filtered;
  }

  private deduplicateByPriority(items: MemoryItem[]): MemoryItem[] {
    const seen = new Map<string, MemoryItem>();
    for (const item of items) {
      const existing = seen.get(item.content);
      if (!existing) {
        seen.set(item.content, item);
        continue;
      }

      const currentPriority = MEMORY_PRIORITY[item.memory_type ?? ""] ?? 0;
      const existingPriority = MEMORY_PRIORITY[existing.memory_type ?? ""] ?? 0;
      if (currentPriority > existingPriority) {
        seen.set(item.content, item);
      }
    }
    return [...seen.values()];
  }
}
