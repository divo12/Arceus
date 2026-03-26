import { createSidecarHippocampusBridge } from "./hippocampus-client.js";
import { initializeMemoryServices, resetMemoryServices } from "./memory-services.js";
import type {
  ExtractResult,
  GraphEdge,
  GraphNode,
  HabitItem,
  HealthResult,
  HippocampusBridge,
  HippocampusRuntimeDiagnostics,
  MemoryItem,
  MemoryListItem,
  MemorySummary,
  PromotionItem,
} from "./hippocampus-contract.js";
import { HippocampusDisabledError } from "./hippocampus-contract.js";
import { type HippocampusMode } from "../config.js";
import {
  HippocampusRuntimeManager,
  resolveDefaultHippocampusRuntimeOptions,
} from "./hippocampus-runtime-manager.js";

export interface HippocampusBridgeConfig {
  mode: HippocampusMode;
  apiUrl?: string;
  pythonBin: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface ManagedHippocampusBridge extends HippocampusBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): HippocampusRuntimeDiagnostics | null;
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
  async getHabits(): Promise<{ habits: HabitItem[] }> { return this.fail(); }
  async getSummary(): Promise<MemorySummary> { return this.fail(); }
  async listMemories(): Promise<{ items: MemoryListItem[]; total: number }> { return this.fail(); }
  async graphSearch(): Promise<{ nodes: GraphNode[] }> { return this.fail(); }
  async graphNeighbors(): Promise<{ nodes: GraphNode[] }> { return this.fail(); }
  async graphEdges(): Promise<{ edges: GraphEdge[] }> { return this.fail(); }
  async graphVersionHistory(): Promise<{ versions: GraphNode[] }> { return this.fail(); }
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
      include_graph: true,
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

  async getHabits(agentId: string, context = "") {
    return this.runtime.call("getHabits", { agent_id: agentId, context });
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

  async graphSearch(agentId: string, query: string, container = "default", topK = 10) {
    return this.runtime.call("graphSearch", {
      agent_id: agentId,
      query,
      container,
      top_k: topK,
    });
  }

  async graphNeighbors(agentId: string, nodeId: string, maxHops = 2) {
    return this.runtime.call("graphNeighbors", {
      agent_id: agentId,
      node_id: nodeId,
      max_hops: maxHops,
    });
  }

  async graphEdges(agentId: string, nodeId: string) {
    return this.runtime.call("graphEdges", {
      agent_id: agentId,
      node_id: nodeId,
    });
  }

  async graphVersionHistory(agentId: string, memoryId: string) {
    return this.runtime.call("graphVersionHistory", {
      agent_id: agentId,
      memory_id: memoryId,
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

class SidecarManagedBridge implements ManagedHippocampusBridge {
  readonly mode = "sidecar" as const;

  constructor(private readonly delegate: HippocampusBridge) {}

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    await this.delegate.close();
  }

  diagnostics(): HippocampusRuntimeDiagnostics | null {
    return null;
  }

  health() { return this.delegate.health(); }
  remember(agentId: string, content: string, container = "default", memoryType = "dynamic") {
    return this.delegate.remember(agentId, content, container, memoryType);
  }
  recall(agentId: string, query: string, container = "default", topK = 10) {
    return this.delegate.recall(agentId, query, container, topK);
  }
  extract(agentId: string, messages: Array<{ role: string; content: string }>, container = "default") {
    return this.delegate.extract(agentId, messages, container);
  }
  processTrajectory(
    agentId: string,
    taskId: string,
    outcome: string,
    quality: number,
    steps: Array<{ action: string; result: string; reasoning?: string }> = [],
    container = "default",
  ) {
    return this.delegate.processTrajectory(agentId, taskId, outcome, quality, steps, container);
  }
  getPriming(agentId: string) { return this.delegate.getPriming(agentId); }
  getHabits(agentId: string, context = "") { return this.delegate.getHabits(agentId, context); }
  getSummary(agentId: string) { return this.delegate.getSummary(agentId); }
  listMemories(agentId: string, memoryType?: string, container?: string, limit = 50) {
    return this.delegate.listMemories(agentId, memoryType, container, limit);
  }
  graphSearch(agentId: string, query: string, container = "default", topK = 10) {
    return this.delegate.graphSearch(agentId, query, container, topK);
  }
  graphNeighbors(agentId: string, nodeId: string, maxHops = 2) {
    return this.delegate.graphNeighbors(agentId, nodeId, maxHops);
  }
  graphEdges(agentId: string, nodeId: string) {
    return this.delegate.graphEdges(agentId, nodeId);
  }
  graphVersionHistory(agentId: string, memoryId: string) {
    return this.delegate.graphVersionHistory(agentId, memoryId);
  }
  runGC(agentId: string) { return this.delegate.runGC(agentId); }
  runPromotions(agentId: string) { return this.delegate.runPromotions(agentId); }
  close() { return this.delegate.close(); }
}

export function createEmbeddedHippocampusBridge(
  runtime: Pick<HippocampusRuntimeManager, "start" | "stop" | "call" | "diagnostics">,
): ManagedHippocampusBridge {
  return new EmbeddedHippocampusBridge(runtime);
}

export function createManagedSidecarHippocampusBridge(baseUrl: string): ManagedHippocampusBridge {
  return new SidecarManagedBridge(createSidecarHippocampusBridge(baseUrl));
}

export { createSidecarHippocampusBridge };

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

  if (config.mode === "sidecar") {
    hippocampusBridge = createManagedSidecarHippocampusBridge(config.apiUrl ?? "http://localhost:8100");
    initializeMemoryServices(hippocampusBridge);
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
