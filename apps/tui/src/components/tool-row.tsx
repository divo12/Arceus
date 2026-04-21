import React from "react";
import { Box, Text } from "ink";
import { roleColor, roleShort } from "../theme.js";
import type { AuditEvent } from "../hooks/use-audit.js";

interface ToolRowProps {
  event: AuditEvent;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return "??:??:??";
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "error":
      return "red";
    case "warn":
      return "yellow";
    case "debug":
      return "gray";
    default:
      return "white";
  }
}

function severityGlyph(severity: string): string {
  switch (severity) {
    case "error":
      return "✗";
    case "warn":
      return "⚠";
    case "debug":
      return "·";
    default:
      return "│";
  }
}

export function ToolRow({ event }: ToolRowProps) {
  const time = formatTime(event.occurredAt);
  const role = event.agentRole ?? "system";
  const sColor = severityColor(event.severity);
  const glyph = severityGlyph(event.severity);

  const summary = event.summary.length > 55
    ? event.summary.slice(0, 52) + "..."
    : event.summary;

  return (
    <Box>
      <Text dimColor>[{time}]</Text>
      <Text> </Text>
      <Text color={roleColor(role)} bold>
        {roleShort(role)}
      </Text>
      <Text> </Text>
      <Text color={sColor}>{glyph}</Text>
      <Text> </Text>
      <Text color="magenta">{event.eventType}</Text>
      <Text> </Text>
      <Text color={sColor}>{summary}</Text>
    </Box>
  );
}
