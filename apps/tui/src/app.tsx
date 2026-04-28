import React, { useState, useCallback } from "react";
import { Box, useInput, useApp, useStdout } from "ink";
import { Header } from "./components/header.js";
import { StatusBar } from "./components/status-bar.js";
import { useHeartbeat } from "./hooks/use-heartbeat.js";
import { apiPost } from "./api/client.js";
import { BuildView } from "./views/build.js";
import { SprintView } from "./views/sprint-nav.js";
import { WorkspaceView } from "./views/workspace.js";

export function App() {
  const [activeTab, setActiveTab] = useState(0);
  const { status, start, stop, trigger } = useHeartbeat();
  const { exit } = useApp();
  const { stdout } = useStdout();

  const termHeight = stdout?.rows ?? 24;
  const contentHeight = Math.max(termHeight - 12, 5);

  // Build tab (0) has input — Escape yields focus to app-level keybinds
  // Sprint tab (1) has cursor navigation — also captures input when focused
  const [viewFocused, setViewFocused] = useState(true);

  const handleViewEscape = useCallback(() => {
    setViewFocused(false);
  }, []);

  const quickExecute = useCallback(async (idea: string) => {
    try {
      await apiPost("/api/quick-execute", { idea });
    // eslint-disable-next-line no-restricted-syntax -- intentional: TUI quick-execute is fire-and-forget; failure is non-critical for the UI.
    } catch {
      // non-critical
    }
  }, []);

  const approve = useCallback(async () => {
    try {
       
      await apiPost("/api/sprint-proposal/approve");
    // eslint-disable-next-line no-restricted-syntax -- intentional: TUI sprint approve fire-and-forget.
    } catch {
      // non-critical
    }
  }, []);

  useInput((input, key) => {
    // When view is focused on Build/Sprint tab, swallow input
    if ((activeTab === 0 || activeTab === 1) && viewFocused) {
      return;
    }

    // After Escape on Build/Sprint: re-focus on Enter or non-shortcut key
    if ((activeTab === 0 || activeTab === 1) && !viewFocused) {
      if (key.return || (input && !["s", "x", "t", "a", "q"].includes(input) && !(input >= "1" && input <= "3"))) {
        setViewFocused(true);
        return;
      }
    }

    // Tab switching (1-3)
    if (input >= "1" && input <= "3") {
      setActiveTab(Number(input) - 1);
      setViewFocused(true);
      return;
    }

    // Heartbeat controls
    if (input === "s") { start(); return; }
    if (input === "x") { stop(); return; }
    if (input === "t") { trigger(); return; }

    // Approve
    if (input === "a") { approve(); return; }

    // Quit
    if (input === "q") { exit(); return; }
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

      <Box flexDirection="column" flexGrow={1} height={contentHeight}>
        {activeTab === 0 && (
          <BuildView
            height={contentHeight}
            active={viewFocused}
            onEscape={handleViewEscape}
            onQuickExecute={quickExecute}
            onStop={stop}
          />
        )}
        {activeTab === 1 && (
          <SprintView
            height={contentHeight}
            active={viewFocused}
            onEscape={handleViewEscape}
          />
        )}
        {activeTab === 2 && <WorkspaceView height={contentHeight} />}
      </Box>

      <StatusBar status={status} />
    </Box>
  );
}
