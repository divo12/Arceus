import React, { useState, useCallback } from "react";
import { Box, useInput, useApp, useStdout } from "ink";
import { Header } from "./components/header.js";
import { StatusBar } from "./components/status-bar.js";
import { useHeartbeat } from "./hooks/use-heartbeat.js";
import { BeatsView } from "./views/beats.js";
import { SessionsView } from "./views/sessions.js";
import { AgentsView } from "./views/agents.js";
import { SprintView } from "./views/sprint.js";
import { MeetingsView } from "./views/meetings.js";
import { TimelineView } from "./views/timeline.js";

export function App() {
  const [activeTab, setActiveTab] = useState(0);
  const { status, start, stop, trigger } = useHeartbeat();
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Available height for the content area (terminal height minus header/footer)
  const termHeight = stdout?.rows ?? 24;
  const contentHeight = Math.max(termHeight - 12, 5);

  // Build tab (0) has a chat input — Escape yields focus to app-level keybinds
  const [chatFocused, setChatFocused] = useState(true);
  const onBuildTab = activeTab === 0;

  // When Build tab's chat input wants to yield control (Escape pressed)
  const handleChatEscape = useCallback(() => {
    setChatFocused(false);
  }, []);

  useInput((input, key) => {
    // When chat is focused on Build tab, swallow all input
    if (onBuildTab && chatFocused) {
      return;
    }

    // On Build tab after Escape: any key re-focuses chat, but first handle shortcuts
    if (onBuildTab && !chatFocused) {
      // Re-focus chat on Enter or any printable character that isn't a shortcut
      if (key.return || (input && !["s", "x", "t", "q"].includes(input) && !(input >= "1" && input <= "6"))) {
        setChatFocused(true);
        return;
      }
    }

    // Tab switching
    if (input >= "1" && input <= "6") {
      setActiveTab(Number(input) - 1);
      if (Number(input) - 1 === 0) setChatFocused(true);
      return;
    }

    // Heartbeat controls
    if (input === "s") {
      start();
      return;
    }
    if (input === "x") {
      stop();
      return;
    }
    if (input === "t") {
      trigger();
      return;
    }

    // Quit
    if (input === "q") {
      exit();
      return;
    }
  });

  const heartbeatRunning = status?.running ?? false;
  const beatCount = status?.beatCount ?? 0;

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header
        connected={true}
        heartbeatRunning={heartbeatRunning}
        beatCount={beatCount}
        activeTab={activeTab}
      />

      {/* Content area */}
      <Box flexDirection="column" flexGrow={1} height={contentHeight}>
        {activeTab === 0 && <TimelineView height={contentHeight} active={chatFocused} onEscape={handleChatEscape} onQuickExecute={start} />}
        {activeTab === 1 && <BeatsView height={contentHeight} />}
        {activeTab === 2 && <SessionsView height={contentHeight} />}
        {activeTab === 3 && <AgentsView />}
        {activeTab === 4 && <SprintView />}
        {activeTab === 5 && <MeetingsView />}
      </Box>

      <StatusBar status={status} />
    </Box>
  );
}
