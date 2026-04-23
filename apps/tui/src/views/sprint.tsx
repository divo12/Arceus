import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { Spinner } from "../components/spinner.js";
import { TaskRow, type TaskInfo, type TaskStats } from "../components/task-row.js";
import { usePoll } from "../hooks/use-poll.js";
import { useThrottledActivity, type ActivityEvent } from "../hooks/use-throttled-activity.js";

interface CompanyResponse {
  company?: {
    name?: string;
    budgetCents?: number;
    spentCents?: number;
  };
  currentSprint?: {
    number?: number;
    title?: string;
    status?: string;
    goalStatement?: string;
  };
  tasks?: Array<{
    id: string;
    title: string;
    status: string;
    assignedRole?: string;
    priority?: string;
  }>;
}

const TODO_STATUSES = new Set(["todo", "pending", "open", "ready"]);
const IN_PROGRESS_STATUSES = new Set(["in_progress", "in-progress", "running"]);
const DONE_STATUSES = new Set(["completed", "done", "verified"]);

/** Aggregate per-task stats from activity events */
function aggregateTaskStats(events: ActivityEvent[]): Map<string, TaskStats> {
  const map = new Map<string, TaskStats>();
  for (const e of events) {
    if (!e.taskId || !e.detail) continue;
    try {
      const d = typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
      const tc = d.beatToolCalls ?? d.toolCalls ?? 0;
      const fe = d.beatFileEdits ?? d.fileEdits ?? 0;
      const sc = d.beatShellCmds ?? d.shellCmds ?? 0;
      if (tc === 0 && fe === 0 && sc === 0) continue;
      const prev = map.get(e.taskId) ?? { toolCalls: 0, fileEdits: 0, shellCmds: 0 };
      map.set(e.taskId, {
        toolCalls: prev.toolCalls + tc,
        fileEdits: prev.fileEdits + fe,
        shellCmds: prev.shellCmds + sc,
      });
    } catch { /* ignore parse errors */ }
  }
  return map;
}

export function SprintView() {
  const { data, loading, error } = usePoll<CompanyResponse>("/api/company", 3000);
  const { events: activityEvents } = useThrottledActivity();
  const taskStats = useMemo(() => aggregateTaskStats(activityEvents), [activityEvents]);

  if (loading) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner />
        </Text>
        <Text> Loading sprint...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const sprint = data?.currentSprint;
  const tasks: TaskInfo[] = (data?.tasks ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    assignedRole: t.assignedRole,
    priority: t.priority,
  }));

  const todo = tasks.filter((t) => TODO_STATUSES.has(t.status));
  const inProgress = tasks.filter((t) => IN_PROGRESS_STATUSES.has(t.status));
  const done = tasks.filter((t) => DONE_STATUSES.has(t.status));
  const other = tasks.filter(
    (t) =>
      !TODO_STATUSES.has(t.status) &&
      !IN_PROGRESS_STATUSES.has(t.status) &&
      !DONE_STATUSES.has(t.status),
  );

  return (
    <Box flexDirection="column">
      {/* Sprint header */}
      {sprint ? (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color="cyan">
              Sprint #{sprint.number}: {sprint.title}
            </Text>
            <Text> </Text>
            <Text color="gray">[{sprint.status}]</Text>
          </Box>
          {sprint.goalStatement && (
            <Box marginLeft={2}>
              <Text dimColor>{sprint.goalStatement}</Text>
            </Box>
          )}
        </Box>
      ) : (
        <Text dimColor>No active sprint.</Text>
      )}

      {/* Three-column task board */}
      <Box>
        {/* TODO */}
        <Box flexDirection="column" width="33%">
          <Text bold color="white">
            ○ TODO ({todo.length})
          </Text>
          <Text color="gray">{"─".repeat(22)}</Text>
          {todo.map((t) => (
            <TaskRow key={t.id} task={t} stats={taskStats.get(t.id)} />
          ))}
        </Box>

        {/* IN PROGRESS */}
        <Box flexDirection="column" width="33%">
          <Text bold color="yellow">
            ▶ IN PROGRESS ({inProgress.length})
          </Text>
          <Text color="gray">{"─".repeat(22)}</Text>
          {inProgress.map((t) => (
            <TaskRow key={t.id} task={t} stats={taskStats.get(t.id)} />
          ))}
        </Box>

        {/* DONE */}
        <Box flexDirection="column" width="33%">
          <Text bold color="green">
            ✓ DONE ({done.length})
          </Text>
          <Text color="gray">{"─".repeat(22)}</Text>
          {done.map((t) => (
            <TaskRow key={t.id} task={t} stats={taskStats.get(t.id)} />
          ))}
        </Box>
      </Box>

      {/* Other statuses */}
      {other.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="gray">
            OTHER ({other.length})
          </Text>
          {other.map((t) => (
            <TaskRow key={t.id} task={t} stats={taskStats.get(t.id)} />
          ))}
        </Box>
      )}
    </Box>
  );
}
