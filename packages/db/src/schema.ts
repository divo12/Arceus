import type { EntityName, TableDefinition } from "./types";

export const arceusTableDefinitions: Record<EntityName, TableDefinition> = {
  companies: {
    entity: "companies",
    tableName: "companies",
    primaryKey: "id",
    notes: "Root company record with current sprint pointer.",
    indexes: ["status", "current_sprint_id"]
  },
  ideas: {
    entity: "ideas",
    tableName: "ideas",
    primaryKey: "id",
    notes: "Original and refined company idea state.",
    indexes: ["company_id"]
  },
  strategies: {
    entity: "strategies",
    tableName: "strategies",
    primaryKey: "id",
    notes: "CEO strategy proposals and approved sprint plans.",
    indexes: ["company_id", "status"]
  },
  sprints: {
    entity: "sprints",
    tableName: "sprints",
    primaryKey: "id",
    notes: "Sprint lifecycle records and numbering.",
    indexes: ["company_id", "number", "status"]
  },
  hierarchy: {
    entity: "hierarchy",
    tableName: "hierarchy_nodes",
    primaryKey: "id",
    notes: "Org-chart hierarchy and reporting structure.",
    indexes: ["role", "parent_node_id"]
  },
  agents: {
    entity: "agents",
    tableName: "agents",
    primaryKey: "id",
    notes: "Agent identities, roles, and runtime status.",
    indexes: ["company_id", "role", "status"]
  },
  sessions: {
    entity: "sessions",
    tableName: "sessions",
    primaryKey: "id",
    notes: "OpenCode session bindings per agent.",
    indexes: ["agent_id", "runtime_status"]
  },
  tasks: {
    entity: "tasks",
    tableName: "tasks",
    primaryKey: "id",
    notes: "Sprint-scoped tasks and dependency metadata.",
    indexes: ["company_id", "sprint_id", "status", "assigned_agent_id"]
  },
  artifacts: {
    entity: "artifacts",
    tableName: "artifacts",
    primaryKey: "id",
    notes: "Persisted agent outputs for handoff and review.",
    indexes: ["company_id", "sprint_id", "task_id", "kind"]
  },
  chatMessages: {
    entity: "chatMessages",
    tableName: "chat_messages",
    primaryKey: "id",
    notes: "Board, CEO, and system chat history.",
    indexes: ["company_id", "sprint_id", "created_at"]
  },
  meetings: {
    entity: "meetings",
    tableName: "meetings",
    primaryKey: "id",
    notes: "Formal meetings, decisions, and mutations.",
    indexes: ["company_id", "status", "scheduled_at"]
  },
  approvals: {
    entity: "approvals",
    tableName: "approvals",
    primaryKey: "id",
    notes: "Board approvals for strategy, blockers, and external actions.",
    indexes: ["company_id", "type", "status"]
  },
  events: {
    entity: "events",
    tableName: "events",
    primaryKey: "id",
    notes: "Event log for activity fanout and audit.",
    indexes: ["company_id", "event_type", "occurred_at"]
  },
  workspaces: {
    entity: "workspaces",
    tableName: "workspaces",
    primaryKey: "id",
    notes: "Workspace registry rows for local cache plus remote bundle state.",
    indexes: ["company_id", "status", "current_sprint_number"]
  },
  sprintSnapshots: {
    entity: "sprintSnapshots",
    tableName: "sprint_snapshots",
    primaryKey: "id",
    notes: "Sprint boundary snapshots persisted for rollback and recovery.",
    indexes: ["company_id", "sprint_number", "status"]
  },
  assets: {
    entity: "assets",
    tableName: "assets",
    primaryKey: "id",
    notes: "Binary asset registry for screenshots, exports, and stored bundles.",
    indexes: ["company_id", "namespace", "object_key"]
  },
  memorySummaries: {
    entity: "memorySummaries",
    tableName: "memory_summaries",
    primaryKey: "id",
    notes: "Current summarized memory surface used by the existing app.",
    indexes: ["agent_id", "updated_at"]
  },
  memoryUnits: {
    entity: "memoryUnits",
    tableName: "memory_units",
    primaryKey: "id",
    notes: "Atomic hippocampus memory units across static, dynamic, and delegation layers.",
    indexes: ["agent_id", "type", "visibility", "created_at"]
  },
  habits: {
    entity: "habits",
    tableName: "habits",
    primaryKey: "id",
    notes: "Procedural memory and behavioral patterns.",
    indexes: ["agent_id", "status", "usage_count"]
  },
  primingStates: {
    entity: "primingStates",
    tableName: "priming_states",
    primaryKey: "id",
    notes: "Agent confidence, caution, and morale state.",
    indexes: ["agent_id", "updated_at"]
  },
  beatRecords: {
    entity: "beatRecords",
    tableName: "beat_records",
    primaryKey: "id",
    notes: "Heartbeat cycle records (Spec 12). One row per agent beat with timing, cost, and outcome.",
    indexes: ["company_id", "agent_id", "started_at", "beat_number", "status"]
  }
};