import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "../components/spinner.js";
import { MeetingRow, type MeetingInfo } from "../components/meeting-row.js";
import { usePoll } from "../hooks/use-poll.js";

interface MeetingsResponse {
  meetings?: {
    id: string;
    type: string;
    status: string;
    summary?: string;
    participants?: string[];
    decisions?: ({ decision?: string } | string)[];
    scheduledAt?: string;
  }[];
}

export function MeetingsView() {
  const { data, loading, error } = usePoll<MeetingsResponse>("/api/meetings", 5000);

  if (loading) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner />
        </Text>
        <Text> Loading meetings...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const raw = data?.meetings ?? [];

  if (raw.length === 0) {
    return <Text dimColor>No meetings recorded yet.</Text>;
  }

  // Most recent first, limited to 20
  const meetings: MeetingInfo[] = raw
    .slice(-20)
    .reverse()
    .map((m) => ({
      id: m.id,
      type: m.type,
      status: m.status,
      summary: m.summary,
      participants: m.participants,
      decisions: m.decisions?.map((d) =>
        typeof d === "string" ? d : d.decision ?? "",
      ),
      scheduledAt: m.scheduledAt,
    }));

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Recent Meetings ({raw.length} total)
        </Text>
      </Box>
      {meetings.map((m) => (
        <Box key={m.id} marginBottom={1}>
          <MeetingRow meeting={m} />
        </Box>
      ))}
    </Box>
  );
}
