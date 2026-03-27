import { z } from "zod";
import {
  MEETING_TYPES,
  MEETING_STATUSES,
  MEETING_PARTICIPANT_ROLES,
  MEETING_EVENT_KINDS,
} from "../constants.js";

export const agendaItemSchema = z.object({
  topic: z.string().trim().min(1).max(500),
  raisedByAgentId: z.string().uuid().nullable().optional().default(null),
  type: z.enum(["update", "blocker", "question", "proposal"]).default("update"),
  content: z.string().trim().min(1).max(5000),
});

export type AgendaItemInput = z.infer<typeof agendaItemSchema>;

export const createMeetingSchema = z.object({
  type: z.enum(MEETING_TYPES),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional().nullable(),
  agenda: z.array(agendaItemSchema).optional().nullable(),
  scheduledAt: z.coerce.date(),
  participantAgentIds: z.array(z.string().uuid()).min(1),
  linkedIssueId: z.string().uuid().optional().nullable(),
  linkedRoutineId: z.string().uuid().optional().nullable(),
});

export type CreateMeeting = z.infer<typeof createMeetingSchema>;

export const updateMeetingSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).optional().nullable(),
  agenda: z.array(agendaItemSchema).optional().nullable(),
  scheduledAt: z.coerce.date().optional(),
  status: z.enum(MEETING_STATUSES).optional(),
});

export type UpdateMeeting = z.infer<typeof updateMeetingSchema>;

export const addMeetingEventSchema = z.object({
  kind: z.enum(MEETING_EVENT_KINDS),
  agentId: z.string().uuid().optional().nullable(),
  content: z.string().trim().min(1).max(10000),
  payload: z.record(z.unknown()).optional().nullable(),
});

export type AddMeetingEvent = z.infer<typeof addMeetingEventSchema>;

export const meetingParticipantContributionSchema = z.object({
  whatIDid: z.string().trim().max(5000).nullable().optional().default(null),
  whatImDoing: z.string().trim().max(5000).nullable().optional().default(null),
  blockers: z.string().trim().max(5000).nullable().optional().default(null),
  learnings: z.string().trim().max(5000).nullable().optional().default(null),
});

export type MeetingParticipantContributionInput = z.infer<typeof meetingParticipantContributionSchema>;

export const createEscalationMeetingSchema = z.object({
  blockerAgentId: z.string().uuid(),
  description: z.string().trim().min(1).max(5000),
  linkedIssueId: z.string().uuid().optional().nullable(),
});

export type CreateEscalationMeeting = z.infer<typeof createEscalationMeetingSchema>;
