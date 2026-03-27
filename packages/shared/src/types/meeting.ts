import type {
  MeetingType,
  MeetingStatus,
  MeetingParticipantRole,
  MeetingEventKind,
} from "../constants.js";

export interface AgendaItem {
  topic: string;
  raisedByAgentId: string | null;
  type: "update" | "blocker" | "question" | "proposal";
  content: string;
}

export interface MeetingParticipantContribution {
  whatIDid: string | null;
  whatImDoing: string | null;
  blockers: string | null;
  learnings: string | null;
}

export interface MeetingParticipant {
  id: string;
  companyId: string;
  meetingId: string;
  agentId: string;
  role: MeetingParticipantRole;
  joinedAt: Date | null;
  contribution: MeetingParticipantContribution | null;
  createdAt: Date;
  /** Resolved agent name – populated when hydrated */
  agentName?: string;
  /** Resolved agent role – populated when hydrated */
  agentRole?: string;
}

export interface MeetingEvent {
  id: string;
  companyId: string;
  meetingId: string;
  seq: number;
  kind: MeetingEventKind;
  agentId: string | null;
  content: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
  /** Resolved agent name – populated when hydrated */
  agentName?: string;
  agentRole?: string;
}

export interface MeetingSummary {
  id: string;
  type: MeetingType;
  status: MeetingStatus;
  title: string;
  scheduledAt: Date;
  participantCount: number;
}

export interface Meeting {
  id: string;
  companyId: string;
  type: MeetingType;
  status: MeetingStatus;
  title: string;
  description: string | null;
  agenda: AgendaItem[] | null;
  scheduledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  linkedIssueId: string | null;
  linkedRoutineId: string | null;
  initiatedByAgentId: string | null;
  initiatedByUserId: string | null;
  meetingNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MeetingDetail extends Meeting {
  participants: MeetingParticipant[];
  events: MeetingEvent[];
}

export interface MeetingListItem extends Meeting {
  participants: MeetingParticipant[];
  decisionCount: number;
  learningCount: number;
}
