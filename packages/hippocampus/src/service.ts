import type { DynamicMemoryStore, GCResult, HippocampusGateway, PreparedAgentContext, PrimingStore, ProceduralMemoryStore, ProcessTaskCompletionInput, StaticMemoryStore } from "./types";
import { InMemoryDynamicStore } from "./tiers/dynamic";
import { InMemoryPrimingStore, createDefaultPrimingState, renderPrimingDisposition, updatePrimingStateFromOutcome } from "./tiers/priming";
import { InMemoryProceduralStore } from "./tiers/procedural";
import { InMemoryStaticStore } from "./tiers/static";
import type { MemoryUnit } from "@arceus/contracts";

function buildCompletionMemoryUnit(input: ProcessTaskCompletionInput): MemoryUnit {
  const now = new Date().toISOString();

  return {
    id: `memory_${crypto.randomUUID()}`,
    companyId: input.companyId,
    agentId: input.agentId,
    sourceTaskId: input.taskId,
    sourceArtifactId: null,
    type: input.outcome === "success" ? "static" : "dynamic",
    visibility: "team",
    source: "task_completion",
    content: input.output,
    summary: input.output.slice(0, 200),
    confidence: input.outcome === "success" ? 0.8 : input.outcome === "partial" ? 0.6 : 0.4,
    tags: ["task-completion"],
    createdAt: now,
    expiresAt: input.outcome === "success" ? null : new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
  };
}

export type HippocampusDependencies = {
  staticStore?: StaticMemoryStore;
  dynamicStore?: DynamicMemoryStore;
  proceduralStore?: ProceduralMemoryStore;
  primingStore?: PrimingStore;
};

export class HippocampusService implements HippocampusGateway {
  private readonly staticStore: StaticMemoryStore;
  private readonly dynamicStore: DynamicMemoryStore;
  private readonly proceduralStore: ProceduralMemoryStore;
  private readonly primingStore: PrimingStore;

  constructor(dependencies: HippocampusDependencies = {}) {
    this.staticStore = dependencies.staticStore ?? new InMemoryStaticStore();
    this.dynamicStore = dependencies.dynamicStore ?? new InMemoryDynamicStore();
    this.proceduralStore = dependencies.proceduralStore ?? new InMemoryProceduralStore();
    this.primingStore = dependencies.primingStore ?? new InMemoryPrimingStore();
  }

  async prepareAgentContext(agentId: string, taskDescription: string): Promise<PreparedAgentContext> {
    const [staticMemories, dynamicMemories, habits, primingState] = await Promise.all([
      this.staticStore.list(agentId),
      this.dynamicStore.list(agentId),
      this.proceduralStore.findMatching(agentId, taskDescription),
      this.primingStore.get(agentId)
    ]);

    return {
      memories: [...staticMemories, ...dynamicMemories].slice(0, 12),
      habits,
      priming: primingState ? renderPrimingDisposition(primingState) : "Neutral. Start with a direct first pass."
    };
  }

  async processTaskCompletion(input: ProcessTaskCompletionInput): Promise<void> {
    const memoryUnit = buildCompletionMemoryUnit(input);
    if (memoryUnit.type === "static") {
      await this.staticStore.add(memoryUnit);
    } else {
      await this.dynamicStore.add(memoryUnit);
    }

    const currentPriming = (await this.primingStore.get(input.agentId)) ?? createDefaultPrimingState(input.agentId, input.companyId);
    const nextPriming = updatePrimingStateFromOutcome(currentPriming, input.outcome, `${input.taskId}:${input.outcome}`);
    await this.primingStore.set(nextPriming);

    const matchedHabits = await this.proceduralStore.findMatching(input.agentId, input.output);
    await this.proceduralStore.incrementUsage(input.agentId, matchedHabits.map((habit) => habit.id));
  }

  async runGC(companyId: string): Promise<GCResult> {
    const [deletedDynamicUnits, deactivatedHabits] = await Promise.all([
      this.dynamicStore.gc(companyId),
      this.proceduralStore.gc(companyId)
    ]);

    return {
      deletedDynamicUnits,
      deactivatedHabits,
      compactedEvents: 0
    };
  }
}

export function createHippocampusService(dependencies?: HippocampusDependencies) {
  return new HippocampusService(dependencies);
}