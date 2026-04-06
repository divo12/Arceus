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
}