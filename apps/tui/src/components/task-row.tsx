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

interface TaskRowProps {
  task: TaskInfo;
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

export function TaskRow({ task }: TaskRowProps) {
  const title = task.title.length > 45
    ? task.title.slice(0, 42) + "..."
    : task.title;
  const color = taskStatusColor(task.status);

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
    </Box>
  );
}
