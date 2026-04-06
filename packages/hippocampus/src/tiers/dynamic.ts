import type { MemoryUnit } from "@arceus/contracts";
import type { DynamicMemoryStore } from "../types";

export class InMemoryDynamicStore implements DynamicMemoryStore {
  private readonly byAgent = new Map<string, MemoryUnit[]>();

  async list(agentId: string): Promise<MemoryUnit[]> {
    return [...(this.byAgent.get(agentId) ?? [])];
  }

  async add(unit: MemoryUnit): Promise<void> {
    const existing = this.byAgent.get(unit.agentId) ?? [];
    this.byAgent.set(unit.agentId, [...existing, unit]);
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