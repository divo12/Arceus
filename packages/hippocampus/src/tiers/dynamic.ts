import type { MemoryUnit } from "@arceus/contracts";
import type { DynamicMemoryStore } from "../types";

/**
 * In-memory implementation of DynamicMemoryStore for testing and local dev.
 * Stores temporary facts that may expire. GC removes expired entries by companyId.
 */
export class InMemoryDynamicStore implements DynamicMemoryStore {
  private readonly byAgent = new Map<string, MemoryUnit[]>();

  async list(agentId: string): Promise<MemoryUnit[]> {
    return [...(this.byAgent.get(agentId) ?? [])];
  }

  async add(unit: MemoryUnit): Promise<void> {
    const existing = this.byAgent.get(unit.agentId) ?? [];
    this.byAgent.set(unit.agentId, [...existing, unit]);
  }

  async update(id: string, content: string, confidence: number): Promise<void> {
    for (const [agentId, units] of this.byAgent.entries()) {
      this.byAgent.set(agentId, units.map((u) =>
        u.id === id ? { ...u, content, confidence, summary: content.slice(0, 200) } : u
      ));
    }
  }

  async softDelete(id: string, reason: string): Promise<void> {
    for (const [agentId, units] of this.byAgent.entries()) {
      this.byAgent.set(agentId, units.filter((u) => u.id !== id));
    }
  }

  async gc(companyId: string): Promise<number> {
    let deleted = 0;

    for (const [agentId, units] of this.byAgent.entries()) {
      const retained = units.filter((unit) => unit.companyId !== companyId || unit.expiresAt === null);
      deleted += units.length - retained.length;
      this.byAgent.set(agentId, retained);
    }

    return deleted;
  }
}