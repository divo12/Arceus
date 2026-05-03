/**
 * Spec 35 §5 — track which meetings were requested from the CEO chat,
 * so when the meeting pipeline completes we can emit a `meeting_summary`
 * card back into the chat transcript.
 *
 * In-memory only (lost on restart). v1 acceptable: meetings finish in
 * minutes, not days. If a restart happens mid-flight the user will see
 * the meeting in /api/meetings but no auto-card — they can ask Avery
 * again.
 */

interface ChatMeetingRequest {
  /** companyId the meeting belongs to */
  companyId: string;
  /** id of the user board message that prompted the request, if any */
  requestedByChatMessageId: string | null;
  /** original topic for nicer card text */
  topic: string;
  /** original question for nicer card text */
  question: string;
  /** roles invited (display only) */
  attendees: string[];
}

const tracker = new Map<string, ChatMeetingRequest>();

export function trackChatMeetingRequest(meetingId: string, req: ChatMeetingRequest): void {
  tracker.set(meetingId, req);
}

export function takeChatMeetingRequest(meetingId: string): ChatMeetingRequest | null {
  const entry = tracker.get(meetingId);
  if (!entry) return null;
  tracker.delete(meetingId);
  return entry;
}

/** For tests / debug. */
export function _trackerSize(): number {
  return tracker.size;
}
