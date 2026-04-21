import React from "react";
import { Box, Text } from "ink";
import { roleColor, roleShort, trustColor } from "../theme.js";

export interface AgentInfo {
  id: string;
  role: string;
  name: string;
  status: string;
  currentTask?: string;
  trustScore?: number;
  lastBeatAt?: string;
}

interface AgentCardProps {
  agent: AgentInfo;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "running":
      return "▶";
    case "active":
    case "idle":
      return "●";
    case "paused":
      return "⏸";
    case "error":
      return "✗";
    default:
      return "○";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "green";
    case "active":
    case "idle":
      return "cyan";
    case "paused":
      return "yellow";
    case "error":
      return "red";
    default:
      return "gray";
  }
}

export function AgentCard({ agent }: AgentCardProps) {
  const trust = agent.trustScore ?? 0;
  const trustBar = "█".repeat(Math.round(trust * 10)) + "░".repeat(10 - Math.round(trust * 10));
  const task = agent.currentTask
    ? agent.currentTask.length > 30
      ? agent.currentTask.slice(0, 27) + "..."
      : agent.currentTask
    : "—";

  return (
    <Box>
      <Box width={5}>
        <Text color={roleColor(agent.role)} bold>
          {roleShort(agent.role)}
        </Text>
      </Box>
      <Box width={3}>
        <Text color={statusColor(agent.status)}>
          {statusGlyph(agent.status)}
        </Text>
      </Box>
      <Box width={14}>
        <Text>{agent.name.slice(0, 12)}</Text>
      </Box>
      <Box width={13}>
        <Text color={trustColor(trust)}>
          {trustBar} {(trust * 100).toFixed(0)}%
        </Text>
      </Box>
      <Box width={35}>
        <Text dimColor>{task}</Text>
      </Box>
    </Box>
  );
}
