import { MemoryServiceError } from "./hippocampus-errors.js";
import type {
  HippocampusBridge,
  PromotionEvent,
} from "./hippocampus-contract.js";

export class MemoryProjectionService {
  constructor(private readonly bridge: HippocampusBridge) {}

  async getPromotionLog(agentId: string, limit = 20): Promise<PromotionEvent[]> {
    try {
      const result = await this.bridge.runPromotions(agentId);
      return result.promotions
        .map((promotion) => ({
          agent_id: agentId,
          memory_id: promotion.memory_id,
          from_type: promotion.from_type ?? promotion.from_tier,
          to_type: promotion.to_type ?? promotion.to_tier,
          reason: promotion.reason ?? "confidence threshold",
          status: promotion.status ?? "completed",
          timestamp: promotion.timestamp ?? new Date().toISOString(),
        }))
        .slice(0, limit);
    } catch (error) {
      throw this.wrapBridgeError(error);
    }
  }

  async getMemoryExplorer(
    agentId: string,
    container: string,
    memoryType?: string,
    limit = 50,
  ) {
    try {
      return this.bridge.listMemories(agentId, memoryType, container, limit);
    } catch (error) {
      throw this.wrapBridgeError(error);
    }
  }

  private wrapBridgeError(error: unknown): MemoryServiceError {
    if (error instanceof MemoryServiceError) {
      return error;
    }
    return new MemoryServiceError(
      error instanceof Error ? error.message : "Hippocampus unavailable",
      502,
      "HIPPOCAMPUS_UNAVAILABLE",
    );
  }
}
