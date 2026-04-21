import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "../components/spinner.js";
import { AgentCard, type AgentInfo } from "../components/agent-card.js";
import { usePoll } from "../hooks/use-poll.js";

interface EmployeeResponse {
  employees?: Array<{
    id: string;
    role: string;
    name: string;
    title: string;
    status: string;
    soul?: { purpose?: string };
    sessions?: Array<{ runtimeStatus?: string }>;
    trustScore?: number;
    currentTaskTitle?: string;
    lastHeartbeatAt?: string;
  }>;
}

export function AgentsView() {
  const { data, loading, error } = usePoll<EmployeeResponse>("/api/employees", 3000);

  if (loading) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner />
        </Text>
        <Text> Loading agents...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const employees = data?.employees ?? [];

  if (employees.length === 0) {
    return <Text dimColor>No agents found. Bootstrap a company first.</Text>;
  }

  // Map to AgentInfo
  const agents: AgentInfo[] = employees.map((e) => ({
    id: e.id,
    role: e.role,
    name: e.name || e.title,
    status: e.sessions?.[0]?.runtimeStatus ?? e.status,
    trustScore: e.trustScore,
    currentTask: e.currentTaskTitle,
    lastBeatAt: e.lastHeartbeatAt ?? undefined,
  }));

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box>
        <Box width={5}>
          <Text bold color="gray">ROLE</Text>
        </Box>
        <Box width={3}>
          <Text bold color="gray">ST</Text>
        </Box>
        <Box width={14}>
          <Text bold color="gray">NAME</Text>
        </Box>
        <Box width={13}>
          <Text bold color="gray">TRUST</Text>
        </Box>
        <Box width={35}>
          <Text bold color="gray">CURRENT TASK</Text>
        </Box>
      </Box>
      <Box>
        <Text color="gray">{"─".repeat(70)}</Text>
      </Box>
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </Box>
  );
}
