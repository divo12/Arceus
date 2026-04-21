import React from "react";
import { Box, Text } from "ink";
import type { HeartbeatStatus } from "../hooks/use-heartbeat.js";

interface StatusBarProps {
  status: HeartbeatStatus | null;
}

export function StatusBar({ status }: StatusBarProps) {
  const tokens = status?.totalTokens ?? 0;
  const cost = ((status?.totalCostCents ?? 0) / 100).toFixed(2);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">{"─".repeat(72)}</Text>
      </Box>
      <Box>
        <Text dimColor>
          s:start  x:stop  t:trigger  a:approve  1-6:tabs  ↑↓:scroll  q:quit
        </Text>
      </Box>
      <Box>
        <Text color="cyan">Tokens: </Text>
        <Text>{tokens.toLocaleString()}</Text>
        <Text color="gray"> │ </Text>
        <Text color="yellow">Cost: </Text>
        <Text>${cost}</Text>
        <Text color="gray"> │ </Text>
        <Text color="green">Beats: </Text>
        <Text>{status?.beatCount ?? 0}</Text>
      </Box>
    </Box>
  );
}
