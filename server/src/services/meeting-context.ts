import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, meetings, meetingEvents, meetingParticipants } from "@paperclipai/db";

/**
 * If the run's contextSnapshot contains a meetingId, build a markdown block
 * describing the active meeting so the adapter/agent can participate.
 */
export async function buildMeetingContextForRun(
  db: Db,
  context: Record<string, unknown>,
): Promise<string | null> {
  const meetingId =
    typeof context.meetingId === "string" && context.meetingId.trim().length > 0
      ? context.meetingId.trim()
      : null;

  if (!meetingId) return null;

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  if (!meeting) return null;

  const participantRows = await db
    .select({
      agentName: agents.name,
      agentRole: agents.role,
      role: meetingParticipants.role,
    })
    .from(meetingParticipants)
    .innerJoin(agents, eq(meetingParticipants.agentId, agents.id))
    .where(eq(meetingParticipants.meetingId, meetingId));

  const eventRows = await db
    .select()
    .from(meetingEvents)
    .where(eq(meetingEvents.meetingId, meetingId))
    .orderBy(asc(meetingEvents.seq));

  const lines: string[] = [
    "## Active Meeting",
    "",
    `**Type**: ${meeting.type} | **Title**: ${meeting.title} | **Status**: ${meeting.status}`,
  ];

  if (meeting.description) {
    lines.push("", meeting.description);
  }

  // Agenda
  const agenda = meeting.agenda as Array<{ topic: string; type: string; content: string }> | null;
  if (agenda?.length) {
    lines.push("", "### Agenda");
    for (const [i, item] of agenda.entries()) {
      lines.push(`${i + 1}. **${item.topic}** (${item.type}): ${item.content}`);
    }
  }

  // Participants
  if (participantRows.length) {
    lines.push("", "### Participants");
    for (const p of participantRows) {
      lines.push(`- ${p.agentName}${p.agentRole ? ` (${p.agentRole})` : ""} — ${p.role}`);
    }
  }

  // Prior events (decisions, learnings)
  const decisions = eventRows.filter((e) => e.kind === "decision");
  const learnings = eventRows.filter((e) => e.kind === "learning");

  if (decisions.length) {
    lines.push("", "### Decisions So Far");
    for (const d of decisions) {
      lines.push(`- ${d.content}`);
    }
  }

  if (learnings.length) {
    lines.push("", "### Learnings So Far");
    for (const l of learnings) {
      lines.push(`- ${l.content}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
