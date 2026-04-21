import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  connected: boolean;
  heartbeatRunning: boolean;
  beatCount?: number;
  activeTab: number;
}

const TABS = ["Build", "Beats", "Sessions", "Agents", "Sprint", "Meetings"];

export function Header({ connected, heartbeatRunning, beatCount, activeTab }: HeaderProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          {"  ▄▀█ █▀█ █▀▀ █▀▀ █░█ █▀"}
        </Text>
        <Box flexGrow={1} />
        <Text color={connected ? "green" : "red"}>
          {connected ? "● connected" : "○ disconnected"}
        </Text>
        <Text> │ </Text>
        <Text color={heartbeatRunning ? "green" : "gray"}>
          {heartbeatRunning ? `♥ running (#${beatCount ?? 0})` : "♡ stopped"}
        </Text>
      </Box>
      <Box>
        <Text bold color="cyan">
          {"  █▀█ █▀▄ █▄▄ ██▄ █▄█ ▄█"}
        </Text>
      </Box>
      <Box marginTop={1}>
        {TABS.map((tab, i) => (
          <React.Fragment key={tab}>
            <Text
              bold={activeTab === i}
              color={activeTab === i ? "cyan" : "gray"}
              inverse={activeTab === i}
            >
              {` ${i + 1}:${tab} `}
            </Text>
            {i < TABS.length - 1 && <Text color="gray"> </Text>}
          </React.Fragment>
        ))}
      </Box>
      <Box>
        <Text color="gray">{"─".repeat(72)}</Text>
      </Box>
    </Box>
  );
}
