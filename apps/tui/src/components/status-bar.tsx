import React from "react";
import { Box, Text } from "ink";
import type { HeartbeatStatus } from "../hooks/use-heartbeat.js";

interface StatusBarProps {
  status: HeartbeatStatus | null;
}

export function StatusBar({ status }: StatusBarProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">{"─".repeat(72)}</Text>
      </Box>
      <Box>
        <Text dimColor>
          s:start  x:stop  t:trigger  a:approve  1-3:tabs  ↑↓:scroll  q:quit
        </Text>
      </Box>
      <Box>
        <Text color={status?.running ? "green" : "gray"}>
          {status?.running ? "♥ running" : "♡ stopped"}
        </Text>
        <Text color="gray"> │ </Text>
        <Text color="cyan">Beats: </Text>
        <Text>{status?.beatCount ?? 0}</Text>
      </Box>
    </Box>
  );
}
