import { initializeMemoryServices, resetMemoryServices } from "./memory-services.js";
import type { DelegationStyle } from "@paperclipai/shared";
import type {
  ExtractResult,
  HabitItem,
  HealthResult,
  HippocampusBridge,
  HippocampusRuntimeDiagnostics,
  MemoryItem,
  MemoryListItem,
  MemorySummary,
  PromotionItem,
  StaticMemorySeedInput,
} from "./hippocampus-contract.js";
import { HippocampusDisabledError } from "./hippocampus-contract.js";
import { type HippocampusMode } from "../config.js";
import {
  HippocampusRuntimeManager,
  resolveDefaultHippocampusRuntimeOptions,
} from "./hippocampus-runtime-manager.js";

export interface HippocampusBridgeConfig {
  mode: HippocampusMode;
  pythonBin: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface ManagedHippocampusBridge extends HippocampusBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): HippocampusRuntimeDiagnostics | null;
}

function delegationContextLimit(style: DelegationStyle): number {
  if (style === "directive") return 10;
  if (style === "autonomous") return 3;
  return 5;
}

async function buildDelegationContext(
  bridge: Pick<HippocampusBridge, "getPriming" | "listMemories">,
  delegatorId: string,
  delegateeId: string,
  style: DelegationStyle,
): Promise<string | null> {
  const limit = delegationContextLimit(style);
  const [priming, memories] = await Promise.all([
    bridge.getPriming(delegatorId).catch(() => ({ prompt: "" })),
    bridge.listMemories(delegatorId, undefined, undefined, limit).catch(() => ({ items: [], total: 0 })),
  ]);

  const sections: string[] = [];
  const relationshipMemories = memories.items.filter((memory) => memory.content.includes(delegateeId));
  const rankedMemories = [
    ...relationshipMemories,
    ...memories.items.filter((memory) => !memory.content.includes(delegateeId)),
  ].slice(0, limit);

  sections.push(`## Delegation Context For ${delegateeId}`);

  if (priming.prompt.trim()) {
    sections.push(priming.prompt.trim());
  }

  if (rankedMemories.length > 0) {
    sections.push(
      rankedMemories
        .map((memory) => `- [${memory.memory_type ?? "memory"}] ${memory.content}`)
        .join("\n"),
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

class DisabledHippocampusBridge implements ManagedHippocampusBridge {
  readonly mode = "off" as const;

  private fail(): never {
    throw new HippocampusDisabledError();
  }

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  diagnostics(): HippocampusRuntimeDiagnostics | null {
    return null;
  }

  async health(): Promise<HealthResult> { return this.fail(); }
  async remember(): Promise<{ id: string; content: string; memory_type: string; confidence: number }> { return this.fail(); }
  async recall(): Promise<{ items: MemoryItem[] }> { return this.fail(); }
  async extract(): Promise<ExtractResult> { return this.fail(); }
  async processTrajectory(): Promise<{
    verdict: Record<string, unknown> | null;
    distilled: Record<string, unknown> | null;
    pattern: Record<string, unknown> | null;
    habit: Record<string, unknown> | null;
  }> { return this.fail(); }
  async getPriming(): Promise<{ prompt: string }> { return this.fail(); }
  async getDelegationContext(): Promise<string | null> { return this.fail(); }
  async getHabits(): Promise<{ habits: HabitItem[] }> { return this.fail(); }
  async storeStaticMemory(): Promise<{ id: string; content: string; memory_type: string; confidence: number }> {
    return this.fail();
  }
  async getSummary(): Promise<MemorySummary> { return this.fail(); }
  async listMemories(): Promise<{ items: MemoryListItem[]; total: number }> { return this.fail(); }
  async runGC(): Promise<{ expired: number; decayed: number; demoted: number }> { return this.fail(); }
  async runPromotions(): Promise<{ promotions: PromotionItem[] }> { return this.fail(); }
  async close(): Promise<void> { return; }
}

export class EmbeddedHippocampusBridge implements ManagedHippocampusBridge {
  readonly mode = "embedded" as const;

  constructor(private readonly runtime: Pick<HippocampusRuntimeManager, "start" | "stop" | "call" | "diagnostics">) {}

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  diagnostics(): HippocampusRuntimeDiagnostics {
    return this.runtime.diagnostics();
  }

  async health() {
    return this.runtime.call("health", {});
  }

  async remember(agentId: string, content: string, container = "default", memoryType = "dynamic") {
    return this.runtime.call("remember", {
      agent_id: agentId,
      content,
      container,
      memory_type: memoryType,
    });
  }

  async recall(agentId: string, query: string, container = "default", topK = 10) {
    return this.runtime.call("recall", {
      agent_id: agentId,
      query,
      container,
      top_k: topK,
    });
  }

  async extract(agentId: string, messages: Array<{ role: string; content: string }>, container = "default") {
    return this.runtime.call("extract", {
      agent_id: agentId,
      messages,
      container,
      mode: "agent",
    });
  }

  async processTrajectory(
    agentId: string,
    taskId: string,
    outcome: string,
    quality: number,
    steps: Array<{ action: string; result: string; reasoning?: string }> = [],
    container = "default",
  ) {
    return this.runtime.call("processTrajectory", {
      agent_id: agentId,
      task_id: taskId,
      outcome,
      quality,
      steps,
      container,
    });
  }

  async getPriming(agentId: string) {
    return this.runtime.call("getPriming", { agent_id: agentId });
  }

  async getDelegationContext(delegatorId: string, delegateeId: string, style: DelegationStyle) {
    return buildDelegationContext(this, delegatorId, delegateeId, style);
  }

  async getHabits(agentId: string, context = "") {
    return this.runtime.call("getHabits", { agent_id: agentId, context });
  }

  async storeStaticMemory(agentId: string, input: StaticMemorySeedInput) {
    return this.remember(agentId, input.content, input.container ?? "default", "static");
  }

  async getSummary(agentId: string) {
    return this.runtime.call("getSummary", { agent_id: agentId });
  }

  async listMemories(agentId: string, memoryType?: string, container?: string, limit = 50) {
    return this.runtime.call("listMemories", {
      agent_id: agentId,
      memory_type: memoryType,
      container,
      limit,
    });
  }

  async runGC(agentId: string) {
    return this.runtime.call("runGC", { agent_id: agentId });
  }

  async runPromotions(agentId: string) {
    return this.runtime.call("runPromotions", { agent_id: agentId });
  }

  async close() {
    await this.stop();
  }
}

export function createEmbeddedHippocampusBridge(
  runtime: Pick<HippocampusRuntimeManager, "start" | "stop" | "call" | "diagnostics">,
): ManagedHippocampusBridge {
  return new EmbeddedHippocampusBridge(runtime);
}

export let hippocampusBridge: ManagedHippocampusBridge = new DisabledHippocampusBridge();

export function getHippocampusBridge(): ManagedHippocampusBridge {
  return hippocampusBridge;
}

export async function initializeHippocampusBridge(config: HippocampusBridgeConfig): Promise<ManagedHippocampusBridge> {
  await shutdownHippocampusBridge();

  if (config.mode === "off") {
    hippocampusBridge = new DisabledHippocampusBridge();
    resetMemoryServices();
    return hippocampusBridge;
  }

  const runtime = new HippocampusRuntimeManager(
    resolveDefaultHippocampusRuntimeOptions(
      config.pythonBin,
      config.startupTimeoutMs,
      config.requestTimeoutMs,
    ),
  );
  hippocampusBridge = createEmbeddedHippocampusBridge(runtime);
  await hippocampusBridge.start();
  initializeMemoryServices(hippocampusBridge);
  return hippocampusBridge;
}

export async function shutdownHippocampusBridge(): Promise<void> {
  await hippocampusBridge.stop();
  hippocampusBridge = new DisabledHippocampusBridge();
  resetMemoryServices();
}

export function setHippocampusBridgeForTests(bridge: ManagedHippocampusBridge): void {
  hippocampusBridge = bridge;
}

export function resetHippocampusBridgeForTests(): void {
  hippocampusBridge = new DisabledHippocampusBridge();
}
