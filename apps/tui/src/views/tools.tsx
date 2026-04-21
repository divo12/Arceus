import React from "react";
import { Box, Text } from "ink";
import { ToolRow } from "../components/tool-row.js";
import { useAudit } from "../hooks/use-audit.js";

interface ToolsViewProps {
  height: number;
}

export function ToolsView({ height }: ToolsViewProps) {
  const { events, connected } = useAudit();

  if (!connected && events.length === 0) {
    return (
      <Box>
        <Text color="yellow">Connecting to audit stream...</Text>
      </Box>
    );
  }

  const visible = events.slice(-height);

  if (visible.length === 0) {
    return (
      <Box>
        <Text dimColor>No audit events yet. Tool calls will appear here when agents act.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {visible.map((evt) => (
        <ToolRow key={evt.id} event={evt} />
      ))}
    </Box>
  );
}
