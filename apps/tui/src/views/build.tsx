import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { roleColor, roleShort } from "../theme.js";
import { useThrottledActivity, type ActivityEvent } from "../hooks/use-throttled-activity.js";
import { useThrottledAudit, type AuditEvent } from "../hooks/use-throttled-audit.js";
import { usePoll } from "../hooks/use-poll.js";
import { Spinner } from "../components/spinner.js";
import { api } from "../api/client.js";

// ---------- Types ----------

interface MilestoneEntry {
  id: string;
  time: string;
  glyph: string;
  color: string;
  role: string;
  text: string;
  isApproval?: boolean;
  approvalData?: { eventId: string };
}

type ExecPhase = "idle" | "bootstrapping" | "strategizing" | "starting" | "running";

interface CompanyResponse {
  company?: { id?: string; name?: string; status?: string; goal?: string };
  currentSprint?: { number?: number; title?: string; status?: string; goalStatement?: string };
  strategy?: { title?: string; summary?: string; firstRelease?: string; status?: string };
  tasks?: Array<{ id: string; title: string; status: string; assignedRole?: string }>;
}

// ---------- Helpers ----------

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  } catch {
    return "??:??";
  }
}

// Which activity events are milestones — important events only, no spam
const MILESTONE_ACTIVITY = new Set([
  "beat_completed", "beat_failed", "error",
  "transition",   // sprint/task lifecycle changes
  "tool_call",    // MCP tool invocations (sprint_create, task_claim, etc.)
  "shell",        // shell commands executed by agents
  "file_edit",    // files written/modified by agents
]);

// Which audit events are milestones
const MILESTONE_AUDIT = new Set([
  "task_created", "task_completed", "task_failed",
  "sprint_proposed", "sprint_approved", "sprint_started", "sprint_completed",
  "approval_requested", "approval_resolved",
]);

function activityGlyph(type: string): string {
  switch (type) {
    case "beat_completed": return "✓";
    case "beat_failed":    return "✗";
    case "error":          return "!";
    case "transition":     return "→";
    case "tool_call":      return "⚙";
    case "shell":          return "$";
    case "file_edit":      return "✎";
    default:               return "·";
  }
}

function activityColor(type: string): string {
  switch (type) {
    case "beat_completed": return "green";
    case "beat_failed":
    case "error":          return "red";
    case "transition":     return "cyan";
    case "tool_call":      return "magenta";
    case "shell":          return "yellow";
    case "file_edit":      return "blue";
    default:               return "white";
  }
}

function mapActivityMilestone(e: ActivityEvent): MilestoneEntry {
  return {
    id: e.id,
    time: e.timestamp,
    glyph: activityGlyph(e.type),
    color: activityColor(e.type),
    role: e.employee,
    text: e.content,
  };
}

function auditGlyph(t: string): string {
  if (t === "task_created") return "+";
  if (t === "task_completed") return "✓";
  if (t === "task_failed") return "✗";
  if (t.startsWith("sprint_")) return "⟳";
  if (t === "approval_requested") return "⚠";
  if (t === "approval_resolved") return "✓";
  return "·";
}

function auditColor(t: string): string {
  if (t.includes("completed") || t.includes("approved") || t.includes("resolved")) return "green";
  if (t.includes("failed")) return "red";
  if (t.includes("requested") || t.includes("proposed")) return "yellow";
  return "cyan";
}

function mapAuditMilestone(e: AuditEvent): MilestoneEntry {
  const entry: MilestoneEntry = {
    id: e.id,
    time: e.occurredAt,
    glyph: auditGlyph(e.eventType),
    color: auditColor(e.eventType),
    role: e.agentRole ?? "system",
    text: e.summary,
  };
  if (e.eventType === "approval_requested") {
    entry.isApproval = true;
    entry.approvalData = { eventId: e.id };
  }
  return entry;
}

// Strip verbose "Beat cl_XXX: " prefixes from content to save horizontal space
function trimBeatPrefix(text: string): string {
  return text.replace(/^Beat (?:cl_)?[a-z0-9_-]+:\s*/i, "");
}

// Derive "currently working" from most recent activity
function deriveActiveWork(events: ActivityEvent[]): { role: string; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "working" || e.type === "tool_call" || e.type === "file_edit") {
      return { role: e.employee, text: e.content };
    }
    if (e.type === "beat_started") {
      return { role: e.employee, text: `Beat started` };
    }
  }
  return null;
}

// ---------- Component ----------

interface BuildViewProps {
  height: number;
  active: boolean;
  onEscape?: () => void;
  onQuickExecute?: (idea: string) => void;
  onStop?: () => void;
}

export function BuildView({ height, active, onEscape, onQuickExecute, onStop }: BuildViewProps) {
  const { events: activityEvents, connected: actConn, clear: clearActivity } = useThrottledActivity();
  const { events: auditEvents, connected: audConn, clear: clearAudit } = useThrottledAudit();
  const [input, setInput] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);
  const [resetting, setResetting] = useState(false);

  // Blink cursor
  useEffect(() => {
    const iv = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(iv);
  }, []);

  useInput(
    (ch, key) => {
      if (!active) return;

      if (key.escape) {
        onEscape?.();
        return;
      }

      if (key.return) {
        const trimmed = input.trim();
        if (!trimmed) return;

        if (trimmed === "/reset") {
          setInput("");
          setResetting(true);
          onStop?.();
          clearActivity();
          clearAudit();
          api("/api/company", { method: "DELETE" })
            .catch(() => {})
            .finally(() => setResetting(false));
          return;
        }

        setInput("");
        onQuickExecute?.(trimmed);
        return;
      }

      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }

      if (key.ctrl || key.meta) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.tab) return;

      if (ch) {
        setInput((prev) => prev + ch);
      }
    },
    { isActive: active },
  );

  const connected = actConn || audConn;

  // Build milestones
  const milestones = useMemo<MilestoneEntry[]>(() => {
    const entries: MilestoneEntry[] = [
      ...activityEvents.filter((e) => MILESTONE_ACTIVITY.has(e.type)).map(mapActivityMilestone),
      ...auditEvents.filter((e) => MILESTONE_AUDIT.has(e.eventType)).map(mapAuditMilestone),
    ];
    return entries.sort((a, b) => a.time.localeCompare(b.time));
  }, [activityEvents, auditEvents]);

  // Active work status line
  const activeWork = useMemo(() => deriveActiveWork(activityEvents), [activityEvents]);

  // Layout
  const inputAreaHeight = 2;
  const statusLineHeight = activeWork ? 1 : 0;
  const logHeight = Math.max(height - inputAreaHeight - statusLineHeight - 1, 3);
  const visible = milestones.slice(-logHeight);

  return (
    <Box flexDirection="column" height={height}>
      {/* Active work status */}
      {activeWork && (
        <Box>
          <Text color="yellow">⚙ </Text>
          <Text color={roleColor(activeWork.role)} bold>{roleShort(activeWork.role)}</Text>
          <Text dimColor> working on: </Text>
          <Text wrap="truncate-end">
            {(() => { const t = trimBeatPrefix(activeWork.text); return t.length > 60 ? t.slice(0, 57) + "..." : t; })()}
          </Text>
        </Box>
      )}

      {/* Milestone log */}
      <Box flexDirection="column" flexGrow={1}>
        {!connected && milestones.length === 0 && (
          <Text color="yellow">Connecting...</Text>
        )}

        {connected && milestones.length === 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">  No activity yet. Type what to build and press Enter.</Text>
          </Box>
        )}

        {visible.map((entry) => {
          const display = trimBeatPrefix(entry.text);
          return (
          <Box key={entry.id}>
            <Text dimColor>[{formatTime(entry.time)}] </Text>
            <Text color={entry.color}>{entry.glyph} </Text>
            <Text color={roleColor(entry.role)} bold>{roleShort(entry.role)}</Text>
            <Text> </Text>
            <Text color={entry.color} wrap="truncate-end">
              {display.length > 80 ? display.slice(0, 77) + "..." : display}
            </Text>
            {entry.isApproval && (
              <Text color="yellow" bold> [a:approve]</Text>
            )}
          </Box>
          );
        })}
      </Box>

      {/* Input prompt */}
      <Box>
        <Text color={active ? "cyan" : "gray"}>{"› "}</Text>
        <Text>{input}</Text>
        <Text color="cyan">{active && cursorVisible ? "█" : " "}</Text>
        {resetting ? (
          <Box marginLeft={2}><Spinner /><Text dimColor> resetting...</Text></Box>
        ) : input.trim() ? (
          <Box marginLeft={2}><Text dimColor>Enter:execute  /reset</Text></Box>
        ) : null}
      </Box>
    </Box>
  );
}
