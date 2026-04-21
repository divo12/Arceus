import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "../components/spinner.js";
import { TaskRow, type TaskInfo } from "../components/task-row.js";
import { usePoll } from "../hooks/use-poll.js";

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

export function SprintView() {
  const { data, loading, error } = usePoll<CompanyResponse>("/api/company", 3000);

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
            <TaskRow key={t.id} task={t} />
          ))}
        </Box>

        {/* IN PROGRESS */}
        <Box flexDirection="column" width="33%">
          <Text bold color="yellow">
            ▶ IN PROGRESS ({inProgress.length})
          </Text>
          <Text color="gray">{"─".repeat(22)}</Text>
          {inProgress.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </Box>

        {/* DONE */}
        <Box flexDirection="column" width="33%">
          <Text bold color="green">
            ✓ DONE ({done.length})
          </Text>
          <Text color="gray">{"─".repeat(22)}</Text>
          {done.map((t) => (
            <TaskRow key={t.id} task={t} />
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
            <TaskRow key={t.id} task={t} />
          ))}
        </Box>
      )}
    </Box>
  );
}
