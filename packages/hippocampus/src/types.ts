import type { Habit, MemoryUnit, PrimingState } from "@arceus/contracts";

export type PreparedAgentContext = {
  memories: MemoryUnit[];
  habits: Habit[];
  priming: string;
};

export type TaskOutcome = "success" | "partial" | "failure";

export type ProcessTaskCompletionInput = {
  agentId: string;
  taskId: string;
  companyId: string;
  output: string;
  outcome: TaskOutcome;
};

export type GCResult = {
  deletedDynamicUnits: number;
  deactivatedHabits: number;
  compactedEvents: number;
};

export interface HippocampusGateway {
  prepareAgentContext(agentId: string, taskDescription: string): Promise<PreparedAgentContext>;
  processTaskCompletion(input: ProcessTaskCompletionInput): Promise<void>;
  runGC(companyId: string): Promise<GCResult>;
}

export interface StaticMemoryStore {
  list(agentId: string): Promise<MemoryUnit[]>;
  add(unit: MemoryUnit): Promise<void>;
}

export interface DynamicMemoryStore {
  list(agentId: string): Promise<MemoryUnit[]>;
  add(unit: MemoryUnit): Promise<void>;
  gc(companyId: string): Promise<number>;
}

export interface ProceduralMemoryStore {
  list(agentId: string): Promise<Habit[]>;
  findMatching(agentId: string, taskDescription: string): Promise<Habit[]>;
  incrementUsage(agentId: string, habitIds: string[]): Promise<void>;
  gc(companyId: string): Promise<number>;
}

export interface PrimingStore {
  get(agentId: string): Promise<PrimingState | null>;
  set(state: PrimingState): Promise<void>;
}