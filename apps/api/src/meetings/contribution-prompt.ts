import type { Meeting } from "@arceus/contracts";

/**
 * Build the contribution prompt sent to each participant agent during a
 * meeting. The prompt is meeting-type-aware so escalation and eval-triggered
 * meetings get focus-shifting language; daily syncs keep the concise format.
 *
 * The JSON output shape stays identical across all variants so the
 * downstream parser in `collectContributions` continues to work without
 * branching.
 */
export const buildContributionPrompt = (
  meeting: Pick<Meeting, "type" | "title">,
  taskSummary: string,
): string => {
  const trigger = `"${meeting.title}"`;
  const responseFormat =
    "Respond with JSON: { whatIDid, whatImDoing, blockers, learnings, questionsForTeam }";

  if (meeting.type === "eval_triggered") {
    return [
      `You are contributing to an EVAL-FAILURE-TRIGGERED meeting: ${trigger}.`,
      "An evaluation failure has triggered this meeting. In your contribution you MUST:",
      "  • Quote or paraphrase the failing eval explicitly (use the meeting title as the source).",
      "  • Tie 'whatImDoing' or 'blockers' to the eval failure where relevant.",
      "  • Avoid generic status — focus on the failure root cause and your part in resolving it.",
      responseFormat,
      "",
      "Your current tasks:",
      taskSummary,
    ].join("\n");
  }

  if (meeting.type === "escalation") {
    return [
      `You are contributing to an ESCALATION meeting: ${trigger}.`,
      "A blocker or escalation has been raised. In your contribution you MUST:",
      "  • Reference the escalation context explicitly (use the meeting title as the source).",
      "  • Surface anything in your work that may be related, blocking, or unblocking.",
      "  • Be direct about what you need from the team to unblock.",
      responseFormat,
      "",
      "Your current tasks:",
      taskSummary,
    ].join("\n");
  }

  if (meeting.type === "daily_sync") {
    return [
      `You are contributing to a DAILY SYNC: ${trigger}.`,
      "Provide a concise status update covering what you did since last sync, what you're doing now, blockers, learnings, and any questions for the team.",
      responseFormat,
      "",
      "Your current tasks:",
      taskSummary,
    ].join("\n");
  }

  // Fallback for any future/unknown meeting type.
  return [
    `You are contributing to a ${(meeting.type as string).replace(/_/g, " ")} meeting: ${trigger}.`,
    `Provide a concise status update. ${responseFormat}`,
    "",
    "Your current tasks:",
    taskSummary,
  ].join("\n");
};
