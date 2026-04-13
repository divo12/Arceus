import type { MemoryUnit } from "@arceus/contracts";
import type { StaticMemoryStore } from "../types";

export class InMemoryStaticStore implements StaticMemoryStore {
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
}