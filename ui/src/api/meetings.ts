import type {
  Meeting,
  MeetingDetail,
  MeetingListItem,
  MeetingEvent,
  MeetingParticipant,
  MeetingParticipantContribution,
  CreateMeeting,
  CreateEscalationMeeting,
  AddMeetingEvent,
} from "@paperclipai/shared";
import { api } from "./client";

export const meetingsApi = {
  list: (companyId: string, filters?: { type?: string; status?: string }) => {
    const params = new URLSearchParams();
    if (filters?.type) params.set("type", filters.type);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return api.get<MeetingListItem[]>(`/companies/${companyId}/meetings${qs ? `?${qs}` : ""}`);
  },
  get: (meetingId: string) => api.get<MeetingDetail>(`/meetings/${meetingId}`),
  create: (companyId: string, data: CreateMeeting) =>
    api.post<Meeting>(`/companies/${companyId}/meetings`, data),
  update: (meetingId: string, data: Record<string, unknown>) =>
    api.patch<Meeting>(`/meetings/${meetingId}`, data),
  start: (meetingId: string) => api.post<Meeting>(`/meetings/${meetingId}/start`, {}),
  complete: (meetingId: string, notes?: string | null) =>
    api.post<Meeting>(`/meetings/${meetingId}/complete`, { notes }),
  cancel: (meetingId: string) => api.post<Meeting>(`/meetings/${meetingId}/cancel`, {}),
  listEvents: (meetingId: string) => api.get<MeetingEvent[]>(`/meetings/${meetingId}/events`),
  addEvent: (meetingId: string, data: AddMeetingEvent) =>
    api.post<MeetingEvent>(`/meetings/${meetingId}/events`, data),
  submitContribution: (meetingId: string, agentId: string, data: MeetingParticipantContribution) =>
    api.post<MeetingParticipant>(`/meetings/${meetingId}/participants/${agentId}/contribution`, data),
  createEscalation: (companyId: string, data: CreateEscalationMeeting) =>
    api.post<Meeting>(`/companies/${companyId}/meetings/escalation`, data),
};
