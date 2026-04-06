import type {
  AgentIdentity,
  Approval,
  Artifact,
  ChatMessage,
  Company,
  EventEnvelope,
  Habit,
  Meeting,
  MemorySummary,
  MemoryUnit,
  PrimingState,
  SessionBinding,
  Sprint,
  StrategyBrief,
  Task,
  FundamentalIdea,
  HierarchyNode,
} from "@arceus/contracts";

export type EntityName =
  | "companies"
  | "ideas"
  | "strategies"
  | "sprints"
  | "hierarchy"
  | "agents"
  | "sessions"
  | "tasks"
  | "artifacts"
  | "chatMessages"
  | "meetings"
  | "approvals"
  | "events"
  | "memorySummaries"
  | "memoryUnits"
  | "habits"
  | "primingStates";

export type EntityRecordMap = {
  companies: Company;
  ideas: FundamentalIdea;
  strategies: StrategyBrief;
  sprints: Sprint;
  hierarchy: HierarchyNode;
  agents: AgentIdentity;
  sessions: SessionBinding;
  tasks: Task;
  artifacts: Artifact;
  chatMessages: ChatMessage;
  meetings: Meeting;
  approvals: Approval;
  events: EventEnvelope;
  memorySummaries: MemorySummary;
  memoryUnits: MemoryUnit;
  habits: Habit;
  primingStates: PrimingState;
};

export type DatabaseHealth = {
  ok: boolean;
  kind: string;
  details?: string;
};

export interface DatabaseAdapter {
  readonly kind: "noop" | "postgres";
  list<K extends EntityName>(entity: K): Promise<Array<EntityRecordMap[K]>>;
  getById<K extends EntityName>(entity: K, id: string): Promise<EntityRecordMap[K] | null>;
  upsert<K extends EntityName>(entity: K, record: EntityRecordMap[K] & { id: string }): Promise<EntityRecordMap[K]>;
  delete<K extends EntityName>(entity: K, id: string): Promise<boolean>;
  healthCheck(): Promise<DatabaseHealth>;
}

export type TableDefinition<K extends EntityName = EntityName> = {
  entity: K;
  tableName: string;
  primaryKey: "id";
  notes: string;
  indexes: string[];
};