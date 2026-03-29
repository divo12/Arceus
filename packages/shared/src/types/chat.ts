import type { ChatRole, ChatCardType, CardActionType } from "../constants.js";

export type { ChatRole, ChatCardType, CardActionType };

export interface TaskProposalCardData {
  title: string;
  description?: string;
  assigneeRole?: string;
  assigneeAgentId?: string;
  priority?: string;
  projectId?: string;
}

export interface OrgPlanCardData {
  summary: string;
  changes: Array<{
    type: "add_edge" | "remove_edge" | "move_agent";
    parentAgentId?: string;
    childAgentId?: string;
    parentRole?: string;
    childRole?: string;
    description: string;
  }>;
}

export interface IssueCardData {
  title: string;
  description?: string;
  priority?: string;
  assigneeRole?: string;
  assigneeAgentId?: string;
  projectId?: string;
}

export interface BudgetRequestCardData {
  amount: number;
  currency?: string;
  justification: string;
  scope?: string;
}

export interface StatusReportCardData {
  summary: string;
  agentCount: number;
  activeAgentCount: number;
  openTasks: number;
  completedTasks: number;
  budgetSpent: number;
  budgetLimit: number | null;
  pendingEscalations: number;
  agents?: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    currentTask?: string;
  }>;
}

export interface EscalationCardData {
  agentId: string;
  agentName: string;
  agentRole?: string;
  meetingId?: string;
  meetingEventId?: string;
  question: string;
  context?: string;
  severity?: "low" | "medium" | "high";
}

export type ChatCardData =
  | TaskProposalCardData
  | OrgPlanCardData
  | IssueCardData
  | BudgetRequestCardData
  | StatusReportCardData
  | EscalationCardData;

export interface ChatCardState {
  action: CardActionType;
  actedAt: string;
  resultEntityId?: string;
  resultEntityType?: string;
}

export interface ChatMessageMetadata {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
}

export interface ChatMessage {
  id: string;
  companyId: string;
  role: ChatRole;
  content: string;
  cardType: ChatCardType | null;
  cardData: ChatCardData | null;
  cardState: ChatCardState | null;
  agentId: string | null;
  metadata: ChatMessageMetadata | null;
  createdAt: string;
}

export interface ChatInput {
  content: string;
}

export interface ChatCardActionInput {
  action: CardActionType;
  editedData?: Record<string, unknown>;
}

export interface ChatStreamEvent {
  type: "token" | "card" | "done" | "error";
  token?: string;
  cardType?: ChatCardType;
  cardData?: ChatCardData;
  messageId?: string;
  error?: string;
}
