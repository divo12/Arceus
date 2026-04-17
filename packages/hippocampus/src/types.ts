import type { Habit, MemoryUnit, PrimingState } from "@arceus/contracts";

export type PreparedAgentContext = {
  memories: MemoryUnit[];
  habits: Habit[];
  priming: string;
};

export type TaskOutcome = "success" | "partial" | "failure";

export type ExtractedFact = {
  content: string;
  type: "static" | "dynamic" | "procedural";
  confidence: number;
  is_temporal: boolean;
  expiry_days: number | null;
  /** For procedural facts only: the situation/condition */
  trigger?: string;
  /** For procedural facts only: what to do */
  action?: string;
};

/** LLM-powered fact extractor — injected from the API layer */
export type FactExtractor = (agentOutput: string, taskTitle: string, role: string) => Promise<ExtractedFact[]>;

/** LLM action decision result for a single fact */
export type MemoryAction = {
  action: "ADD" | "UPDATE" | "DELETE" | "NONE";
  /** ID of the existing memory to update/delete (null for ADD/NONE) */
  target_id: string | null;
  reason: string;
};

/** LLM-powered action decider — injected from the API layer */
export type ActionDecider = (newFact: string, existingMemories: Array<{ id: string; content: string; type: string; confidence: number }>) => Promise<MemoryAction>;

/** LLM-powered habit matcher — returns IDs of habits relevant to a task */
export type HabitMatcher = (taskDescription: string, habits: Habit[]) => Promise<string[]>;

/** LLM-powered priming disposition generator — returns a one-line behavioral instruction */
export type PrimingGenerator = (state: PrimingState) => Promise<string>;

export type ProcessTaskCompletionInput = {
  agentId: string;
  taskId: string;
  companyId: string;
  output: string;
  outcome: TaskOutcome;
  /** Human-readable task title — used by LLM extractor for context */
  taskTitle?: string;
  /** Agent role (e.g. "developer", "cto") — used by LLM extractor */
  role?: string;
};

export type GCResult = {
  deletedDynamicUnits: number;
  deactivatedHabits: number;
  compactedEvents: number;
};

export interface HippocampusGateway {
  prepareAgentContext(agentId: string, taskDescription: string): Promise<PreparedAgentContext>;
  processTaskCompletion(input: ProcessTaskCompletionInput): Promise<void>;
  /** Store pre-built memory units directly, bypassing LLM extraction. Runs action decider to avoid duplicates. */
  storeMemories(units: MemoryUnit[]): Promise<number>;
  runGC(companyId: string): Promise<GCResult>;
}

export interface StaticMemoryStore {
  list(agentId: string): Promise<MemoryUnit[]>;
  add(unit: MemoryUnit): Promise<void>;
  update(id: string, content: string, confidence: number): Promise<void>;
  softDelete(id: string, reason: string): Promise<void>;
  searchByEmbedding?(
    agentId: string,
    queryEmbedding: number[],
    limit?: number,
  ): Promise<Array<MemoryUnit & { similarity: number }>>;
}

export interface DynamicMemoryStore {
  list(agentId: string): Promise<MemoryUnit[]>;
  add(unit: MemoryUnit): Promise<void>;
  update(id: string, content: string, confidence: number): Promise<void>;
  softDelete(id: string, reason: string): Promise<void>;
  gc(companyId: string): Promise<number>;
  searchByEmbedding?(
    agentId: string,
    queryEmbedding: number[],
    limit?: number,
  ): Promise<Array<MemoryUnit & { similarity: number; decayedScore: number }>>;
}

// ---------------------------------------------------------------------------
// Retrieval engine types
// ---------------------------------------------------------------------------

export type RetrievalOptions = {
  /** Number of final memories to return (default: 5) */
  topK: number;
  /** Over-fetch multiplier — fetch topK * overFetch candidates (default: 3) */
  overFetch: number;
  /** MMR lambda: 0 = max diversity, 1 = max relevance (default: 0.7) */
  lambda: number;
  /** Tier boost multipliers */
  tierBoost: { static: number; dynamic: number };
  /** Scope boost when memory container matches the agent's container */
  scopeBoost: number;
};

export type ScoredMemory = MemoryUnit & {
  /** Raw cosine similarity from pgvector */
  similarity: number;
  /** Final score after tier boost, scope boost, and MMR */
  finalScore: number;
  /** Which tier this came from */
  tier: "static" | "dynamic";
};

export interface ProceduralMemoryStore {
  list(agentId: string): Promise<Habit[]>;
  add(habit: Habit): Promise<void>;
  update(id: string, trigger: string, action: string, confidence: number): Promise<void>;
  softDelete(id: string): Promise<void>;
  findMatching(agentId: string, taskDescription: string): Promise<Habit[]>;
  incrementUsage(agentId: string, habitIds: string[]): Promise<void>;
  gc(companyId: string): Promise<number>;
}

export interface PrimingStore {
  get(agentId: string): Promise<PrimingState | null>;
  set(state: PrimingState): Promise<void>;
}