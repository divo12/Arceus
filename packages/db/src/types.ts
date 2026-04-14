import type {
  AgentIdentity,
  AssetRecord,
  Approval,
  Artifact,
  BeatRecord,
  ChatMessage,
  Company,
  EventEnvelope,
  ExportResult,
  Habit,
  Meeting,
  MemorySummary,
  MemoryUnit,
  PrimingState,
  SessionBinding,
  Sprint,
  SprintSnapshot,
  StrategyBrief,
  Task,
  FundamentalIdea,
  HierarchyNode,
  WorkspaceInfo,
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
  | "workspaces"
  | "sprintSnapshots"
  | "assets"
  | "memorySummaries"
  | "memoryUnits"
  | "habits"
  | "primingStates"
  | "beatRecords";

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
  workspaces: WorkspaceInfo;
  sprintSnapshots: SprintSnapshot;
  assets: AssetRecord;
  memorySummaries: MemorySummary;
  memoryUnits: MemoryUnit;
  habits: Habit;
  primingStates: PrimingState;
  beatRecords: BeatRecord;
};

export type DatabaseHealth = {
  ok: boolean;
  kind: string;
  details?: string;
};

export type DatabaseRuntimeMode = "disabled" | "direct" | "fallback";

export type DatabaseConnectionConfig = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  databaseUrl: string;
  mode: DatabaseRuntimeMode;
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