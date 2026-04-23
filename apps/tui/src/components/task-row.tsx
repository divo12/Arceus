import React from "react";
import { Box, Text } from "ink";
import { taskStatusColor } from "../theme.js";

export interface TaskInfo {
  id: string;
  title: string;
  status: string;
  assignedRole?: string;
  priority?: string;
}

export interface TaskStats {
  toolCalls: number;
  fileEdits: number;
  shellCmds: number;
}

interface TaskRowProps {
  task: TaskInfo;
  stats?: TaskStats;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
    case "in-progress":
      return "▶";
    case "failed":
      return "✗";
    case "blocked":
      return "⊘";
    default:
      return "○";
  }
}

export function TaskRow({ task, stats }: TaskRowProps) {
  const title = task.title.length > 40
    ? task.title.slice(0, 37) + "..."
    : task.title;
  const color = taskStatusColor(task.status);

  const statParts: string[] = [];
  if (stats) {
    if (stats.toolCalls > 0) statParts.push(`⚙${stats.toolCalls}`);
    if (stats.fileEdits > 0) statParts.push(`✎${stats.fileEdits}`);
    if (stats.shellCmds > 0) statParts.push(`$${stats.shellCmds}`);
  }
  const statBadge = statParts.length > 0 ? ` ${statParts.join(" ")}` : "";

  return (
    <Box>
      <Text color={color}>{statusGlyph(task.status)} </Text>
      <Text color={color}>{title}</Text>
      {task.assignedRole && (
        <>
          <Text dimColor> → </Text>
          <Text dimColor>{task.assignedRole}</Text>
        </>
      )}
      {statBadge && <Text color="gray">{statBadge}</Text>}
    </Box>
  );
}
