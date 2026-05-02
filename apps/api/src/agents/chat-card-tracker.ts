/**
 * Per-beat tracker for `chat_emit_card` invocations.
 *
 * `streamBoardMessageToCeo` always runs `classifyCeoResponse` on the
 * CEO's reply text and publishes the resulting card. If the CEO ALSO
 * called `chat_emit_card` (interactive bootstrap flow — idea_refine,
 * name_suggest, hiring_slate, etc.) during the same turn, the
 * classifier card is redundant and renders as a duplicate next to the
 * interactive one. The tracker lets the chat stream skip the classifier
 * pass when the turn already produced an explicit card.
 */
const tracked = new Set<string>();

export function noteChatCardEmitted(beatId: string | null | undefined): void {
  if (beatId) tracked.add(beatId);
}

export function consumeChatCardEmitted(beatId: string | null | undefined): boolean {
  if (!beatId) return false;
  const had = tracked.delete(beatId);
  return had;
}
