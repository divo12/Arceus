import { logger } from "../middleware/logger.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

export interface MeetingWakeupInput {
  heartbeat: IssueAssignmentWakeupDeps;
  meeting: {
    id: string;
    title: string;
    type: string;
  };
  participantAgentIds: string[];
  wakeReason: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
}

/**
 * Wake each participant agent so they can contribute to a meeting.
 * Mirrors queueIssueAssignmentWakeup but for meeting lifecycle events.
 */
export function queueMeetingParticipantWakeup(input: MeetingWakeupInput) {
  const promises = input.participantAgentIds.map((agentId) =>
    input.heartbeat
      .wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: input.wakeReason,
        payload: {
          meetingId: input.meeting.id,
          meetingType: input.meeting.type,
          meetingTitle: input.meeting.title,
        },
        requestedByActorType: input.requestedByActorType ?? "system",
        requestedByActorId: input.requestedByActorId ?? null,
        contextSnapshot: {
          meetingId: input.meeting.id,
          meetingType: input.meeting.type,
          source: "meeting",
        },
      })
      .catch((err) => {
        logger.warn(
          { err, agentId, meetingId: input.meeting.id },
          "failed to wake participant for meeting",
        );
        return null;
      }),
  );

  return Promise.all(promises);
}
