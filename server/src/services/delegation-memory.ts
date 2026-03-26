import type { HippocampusBridge, MemoryListItem } from "./hippocampus-contract.js";
import { MemoryContainers } from "./memory-scope.js";

export interface DelegationResult {
  copiedCount: number;
  failedCount: number;
  memories: MemoryListItem[];
}

export class DelegationMemoryService {
  constructor(private readonly bridge: HippocampusBridge) {}

  async prepareDelegationContext(
    fromAgentId: string,
    toAgentId: string,
    startupId: string,
    taskId: string,
    taskDescription: string,
    topK = 10,
  ): Promise<DelegationResult> {
    const fromContainer = MemoryContainers.employee(startupId, fromAgentId);
    const relevant = await this.bridge.recall(
      fromAgentId,
      taskDescription,
      fromContainer,
      topK,
    );
    const taskContainer = MemoryContainers.task(startupId, taskId);

    const copyOps = relevant.items.map((memory) =>
      this.bridge.remember(
        toAgentId,
        `[delegated:${fromAgentId}] ${memory.content}`,
        taskContainer,
        "dynamic",
      ).then((result) => ({
        id: result.id,
        content: result.content,
        memory_type: result.memory_type,
        confidence: result.confidence,
        relevance_score: memory.relevance_score ?? 0,
        container: taskContainer,
        visibility: null,
        created_at: null,
        updated_at: null,
        access_count: 0,
      })),
    );

    const settled = await Promise.allSettled(copyOps);
    const fulfilled = settled.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<(typeof copyOps)[number]>> => result.status === "fulfilled",
    );
    const memories: MemoryListItem[] = fulfilled.map((result) => result.value);

    return {
      copiedCount: memories.length,
      failedCount: settled.filter((result) => result.status === "rejected").length,
      memories,
    };
  }

  async internalizeDelegationResult(
    agentId: string,
    startupId: string,
    learnings: string[],
    quality: number,
  ): Promise<{ internalized: number }> {
    if (quality < 0.6) {
      return { internalized: 0 };
    }

    const container = MemoryContainers.employee(startupId, agentId);
    const memoryType = quality >= 0.9 ? "static" : "dynamic";
    const settled = await Promise.allSettled(
      learnings.map((learning) => this.bridge.remember(agentId, learning, container, memoryType)),
    );

    return {
      internalized: settled.filter((result) => result.status === "fulfilled").length,
    };
  }
}
