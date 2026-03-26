import {
  GraphUnavailableError,
  MemoryServiceError,
} from "./hippocampus-errors.js";
import type {
  GraphMemoryView,
  GraphNode,
  HippocampusBridge,
  PromotionEvent,
} from "./hippocampus-contract.js";

export class MemoryProjectionService {
  constructor(private readonly bridge: HippocampusBridge) {}

  async getGraphView(
    agentId: string,
    query: string,
    container: string,
    depth = 2,
  ): Promise<GraphMemoryView> {
    try {
      const searchResult = await this.bridge.graphSearch(agentId, query, container, 1);
      const centerNode = searchResult.nodes[0] ?? null;

      if (!centerNode) {
        return { center_node: null, nodes: [], edges: [], depth };
      }

      const [neighbors, edges] = await Promise.all([
        this.bridge.graphNeighbors(agentId, centerNode.id, depth),
        this.bridge.graphEdges(agentId, centerNode.id),
      ]);

      const nodes = [centerNode, ...neighbors.nodes].filter(
        (node, index, items) => items.findIndex((candidate) => candidate.id === node.id) === index,
      );

      return {
        center_node: centerNode,
        nodes,
        edges: edges.edges,
        depth,
      };
    } catch (error) {
      if (this.isGraphStoreError(error)) {
        return { center_node: null, nodes: [], edges: [], depth };
      }
      throw this.wrapBridgeError(error);
    }
  }

  async getVersionHistory(agentId: string, memoryId: string): Promise<GraphNode[]> {
    try {
      return (await this.bridge.graphVersionHistory(agentId, memoryId)).versions;
    } catch (error) {
      if (this.isGraphStoreError(error)) {
        throw new GraphUnavailableError();
      }
      throw this.wrapBridgeError(error);
    }
  }

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

  private isGraphStoreError(error: unknown): boolean {
    return error instanceof Error && (
      error.message.toLowerCase().includes("graph") ||
      error.message.toLowerCase().includes("neo4j") ||
      error.message.includes("ECONNREFUSED")
    );
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
