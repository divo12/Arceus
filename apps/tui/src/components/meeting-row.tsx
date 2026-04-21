import React from "react";
import { Box, Text } from "ink";
import { meetingStatusColor } from "../theme.js";

export interface MeetingInfo {
  id: string;
  type: string;
  status: string;
  summary?: string;
  participants?: string[];
  decisions?: string[];
  scheduledAt?: string;
}

interface MeetingRowProps {
  meeting: MeetingInfo;
}

function typeLabel(type: string): string {
  switch (type) {
    case "standup":
      return "☀ Standup";
    case "planning":
      return "📋 Planning";
    case "review":
      return "🔍 Review";
    case "retro":
      return "↩ Retro";
    case "sync":
      return "🔄 Sync";
    default:
      return `  ${type}`;
  }
}

export function MeetingRow({ meeting }: MeetingRowProps) {
  const color = meetingStatusColor(meeting.status);
  const summary = meeting.summary
    ? meeting.summary.length > 50
      ? meeting.summary.slice(0, 47) + "..."
      : meeting.summary
    : "—";

  const time = meeting.scheduledAt
    ? new Date(meeting.scheduledAt).toLocaleTimeString("en-US", { hour12: false })
    : "";

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{time ? `[${time}] ` : ""}</Text>
        <Text bold>{typeLabel(meeting.type)}</Text>
        <Text> </Text>
        <Text color={color}>[{meeting.status}]</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{summary}</Text>
      </Box>
      {meeting.participants && meeting.participants.length > 0 && (
        <Box marginLeft={2}>
          <Text color="gray">
            Participants: {meeting.participants.join(", ")}
          </Text>
        </Box>
      )}
    </Box>
  );
}
