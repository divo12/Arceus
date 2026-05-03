import React from "react";
import { Box, Text } from "ink";
import { roleColor, roleShort, outcomeColor } from "../theme.js";
import type { ActivityEvent } from "../hooks/use-activity.js";

interface BeatRowProps {
  event: ActivityEvent;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return "??:??:??";
  }
}

// Determine display character for event type
function typeGlyph(type: string): string {
  switch (type) {
    case "beat_started":
      return "▶";
    case "beat_completed":
      return "✓";
    case "beat_failed":
      return "✗";
    case "beat_idle":
      return "·";
    case "working":
      return "⚡";
    case "file_edit":
      return "📝";
    case "shell":
      return "$";
    case "tool_call":
      return "🔧";
    case "error":
      return "✗";
    default:
      return "│";
  }
}

function typeColor(type: string): string {
  switch (type) {
    case "beat_completed":
      return "green";
    case "beat_failed":
    case "error":
      return "red";
    case "beat_started":
    case "working":
      return "yellow";
    case "beat_idle":
      return "gray";
    case "file_edit":
      return "cyan";
    case "tool_call":
      return "magenta";
    default:
      return "white";
  }
}

export function BeatRow({ event }: BeatRowProps) {
  const time = formatTime(event.timestamp);
  const role = event.employee;
  const glyph = typeGlyph(event.type);
  const color = typeColor(event.type);

  // Truncate content to fit terminal
  const content = event.content.length > 60
    ? event.content.slice(0, 57) + "..."
    : event.content;

  return (
    <Box>
      <Text dimColor>[{time}]</Text>
      <Text> </Text>
      <Text color={roleColor(role)} bold>
        {roleShort(role)}
      </Text>
      <Text> </Text>
      <Text color={color}>{glyph}</Text>
      <Text> </Text>
      <Text color={color}>{content}</Text>
    </Box>
  );
}
