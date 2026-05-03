import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { roleColor, roleShort } from "../theme.js";
import { useActivity, type ActivityEvent } from "../hooks/use-activity.js";

/** A beat session groups activity events that share a beatId. */
interface BeatSession {
  beatId: string;
  agent: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "idle";
  events: ActivityEvent[];
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return "??:??:??";
  }
}

function statusGlyph(status: string): string {
  switch (status) {
    case "completed": return "✓";
    case "failed":    return "✗";
    case "running":   return "▶";
    case "idle":      return "·";
    default:          return "?";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "green";
    case "failed":    return "red";
    case "running":   return "yellow";
    default:          return "gray";
  }
}

function eventGlyph(type: string): string {
  switch (type) {
    case "tool_call":   return "🔧";
    case "file_edit":   return "📝";
    case "shell":       return "$";
    case "context":     return "◇";
    case "decision":    return "⬥";
    case "error":       return "✗";
    case "memory":      return "◈";
    case "preview":     return "◎";
    case "prompt":      return "▸";
    case "transition":  return "→";
    default:            return "·";
  }
}

function eventColor(type: string): string {
  switch (type) {
    case "tool_call":   return "magenta";
    case "file_edit":   return "cyan";
    case "shell":       return "yellow";
    case "error":       return "red";
    case "context":     return "blue";
    case "decision":    return "white";
    default:            return "gray";
  }
}

/** Group activity events into beat sessions by beatId. */
function groupByBeat(events: ActivityEvent[]): BeatSession[] {
  const map = new Map<string, ActivityEvent[]>();
  const orphans: ActivityEvent[] = [];

  for (const e of events) {
    if (e.beatId) {
      const group = map.get(e.beatId);
      if (group) group.push(e);
      else map.set(e.beatId, [e]);
    } else {
      orphans.push(e);
    }
  }

  const sessions: BeatSession[] = [];

  for (const [beatId, group] of map) {
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = group[0];
    const last = group[group.length - 1];

    // Determine status from event types
    let status: BeatSession["status"] = "running";
    if (group.some((e) => e.type === "beat_completed")) status = "completed";
    else if (group.some((e) => e.type === "beat_failed")) status = "failed";
    else if (group.some((e) => e.type === "beat_idle")) status = "idle";

    sessions.push({
      beatId,
      agent: first.employee,
      startedAt: first.timestamp,
      endedAt: status !== "running" ? last.timestamp : undefined,
      status,
      events: group,
    });
  }

  // Sort sessions newest first
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sessions;
}

interface SessionsViewProps {
  height: number;
}

export function SessionsView({ height }: SessionsViewProps) {
  const { events, connected } = useActivity();
  const [expandedBeat, setExpandedBeat] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  const sessions = groupByBeat(events);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(sessions.length - 1, c + 1));
    }
    if (key.return) {
      const session = sessions[cursor];
      if (session) {
        setExpandedBeat((prev) => (prev === session.beatId ? null : session.beatId));
      }
    }
  });

  if (!connected && events.length === 0) {
    return (
      <Box>
        <Text color="yellow">Connecting to activity stream...</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No beat sessions yet.</Text>
        <Text dimColor>Press <Text color="cyan" bold>s</Text> to start the heartbeat engine.</Text>
      </Box>
    );
  }

  // Render sessions — if one is expanded, show its events
  const lines: React.ReactNode[] = [];
  let lineCount = 0;

  // Header
  lines.push(
    <Box key="hdr" marginBottom={0}>
      <Text bold color="yellow">Beat Sessions</Text>
      <Text color="gray"> — {sessions.length} sessions</Text>
      <Text color="gray"> │ ↑↓:select  Enter:expand</Text>
    </Box>
  );
  lineCount++;

  for (let i = 0; i < sessions.length && lineCount < height - 1; i++) {
    const s = sessions[i];
    const selected = i === cursor;
    const expanded = expandedBeat === s.beatId;
    const toolCalls = s.events.filter((e) => e.type === "tool_call" || e.type === "file_edit" || e.type === "shell").length;
    const errors = s.events.filter((e) => e.type === "error").length;

    // Duration
    let duration = "";
    if (s.endedAt) {
      const ms = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
      duration = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    }

    lines.push(
      <Box key={s.beatId}>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▸" : " "}</Text>
        <Text dimColor>[{formatTime(s.startedAt)}]</Text>
        <Text> </Text>
        <Text color={statusColor(s.status)}>{statusGlyph(s.status)}</Text>
        <Text> </Text>
        <Text color={roleColor(s.agent)} bold>{roleShort(s.agent)}</Text>
        <Text color="gray"> beat:{s.beatId.slice(0, 8)}</Text>
        <Text color="gray"> {s.events.length}ev</Text>
        {toolCalls > 0 && <Text color="magenta"> 🔧{toolCalls}</Text>}
        {errors > 0 && <Text color="red"> ✗{errors}</Text>}
        {duration && <Text dimColor> {duration}</Text>}
      </Box>
    );
    lineCount++;

    // Show expanded events
    if (expanded) {
      // Filter out beat_started/beat_completed wrapper events — show the inner detail
      const inner = s.events.filter(
        (e) => e.type !== "beat_started" && e.type !== "beat_completed" && e.type !== "beat_failed" && e.type !== "beat_idle",
      );
      for (const evt of inner) {
        if (lineCount >= height - 1) break;
        const truncated = evt.content.length > 80 ? evt.content.slice(0, 77) + "..." : evt.content;
        lines.push(
          <Box key={evt.id} paddingLeft={3}>
            <Text dimColor>{formatTime(evt.timestamp)}</Text>
            <Text> </Text>
            <Text color={eventColor(evt.type)}>{eventGlyph(evt.type)}</Text>
            <Text> </Text>
            <Text color={eventColor(evt.type)} wrap="truncate-end">{truncated}</Text>
            {evt.taskId && <Text dimColor> [task:{evt.taskId.slice(0, 8)}]</Text>}
          </Box>
        );
        lineCount++;
      }
    }
  }

  return <Box flexDirection="column">{lines}</Box>;
}
