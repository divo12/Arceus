import React from "react";
import { Box, Text } from "ink";
import { BeatRow } from "../components/beat-row.js";
import { useActivity } from "../hooks/use-activity.js";

interface BeatsViewProps {
  height: number;
}

export function BeatsView({ height }: BeatsViewProps) {
  const { events, connected } = useActivity();

  if (!connected && events.length === 0) {
    return (
      <Box>
        <Text color="yellow">Connecting to activity stream...</Text>
      </Box>
    );
  }

  // Only show events that belong to a beat session (have beatId or are beat lifecycle)
  const BEAT_TYPES = new Set([
    "beat_started", "beat_completed", "beat_failed", "beat_idle",
  ]);
  const beatEvents = events.filter(
    (e) => e.beatId || BEAT_TYPES.has(e.type),
  );

  // Show the most recent events that fit in the available height
  const visible = beatEvents.slice(-height);

  if (visible.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Waiting for beats...</Text>
        <Text dimColor>Press </Text>
        <Text color="cyan" bold>s</Text>
        <Text dimColor> to start the heartbeat engine.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {visible.map((evt) => (
        <BeatRow key={evt.id} event={evt} />
      ))}
    </Box>
  );
}
