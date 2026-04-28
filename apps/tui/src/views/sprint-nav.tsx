import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { roleColor, roleShort, taskStatusColor } from "../theme.js";
import { useThrottledActivity, type ActivityEvent } from "../hooks/use-throttled-activity.js";
import { usePoll } from "../hooks/use-poll.js";
import { Spinner } from "../components/spinner.js";

// ---------- Types ----------

interface SprintData {
  id?: string;
  number?: number;
  title?: string;
  status?: string;
}

interface TaskData {
  id: string;
  title: string;
  status: string;
  assignedRole?: string;
  priority?: string;
  sprintNumber?: number;
}

interface CompanyResponse {
  currentSprint?: SprintData;
  sprints?: SprintData[];
  tasks?: TaskData[];
}

interface SprintsResponse extends Array<SprintData> {}

/** A row in the navigable list */
type ListRow =
  | { kind: "sprint-header"; sprint: SprintData }
  | { kind: "task"; task: TaskData; beatCount: number; lastBeatTime?: string }
  | { kind: "beat"; event: ActivityEvent; taskId: string }
  | { kind: "error-detail"; text: string; taskId: string };

// ---------- Helpers ----------

function statusGlyph(status: string): string {
  switch (status) {
    case "completed": case "done": return "✓";
    case "in_progress": case "in-progress": case "running": return "▶";
    case "failed": return "✗";
    case "blocked": return "⊘";
    default: return "○";
  }
}

function isInternalRole(role: string): boolean {
  return role.startsWith("_internal/") || role.startsWith("_internal\\");
}

function beatGlyph(type: string): string {
  switch (type) {
    case "beat_completed": return "✓";
    case "beat_failed":    return "✗";
    case "decision":       return "◆";
    case "error":          return "!";
    case "transition":     return "→";
    case "tool_call":      return "⚙";
    case "shell":          return "$";
    case "file_edit":      return "✎";
    default:               return "·";
  }
}

function beatColor(type: string): string {
  switch (type) {
    case "beat_completed":
    case "decision":       return "green";
    case "beat_failed":
    case "error":          return "red";
    case "transition":     return "cyan";
    case "tool_call":      return "magenta";
    case "shell":          return "yellow";
    case "file_edit":      return "blue";
    default:               return "gray";
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  } catch {
    return "??:??";
  }
}

/** Format a beat event into a concise, action-focused label */
function formatBeatLabel(e: ActivityEvent): string {
  if (e.type === "tool_call") {
    // content is "tool: <name>", extract just the name
    const name = e.content.replace(/^tool:\s*/, "");
    return name;
  }
  if (e.type === "file_edit") {
    // content is the file path; try to extract lines changed from detail
    const path = e.content;
    const short = path.length > 50 ? "…" + path.slice(-47) : path;
    let suffix = "";
    if (e.detail) {
      try {
        const d = typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
        if (d.linesChanged) suffix = ` (${d.linesChanged} lines)`;
      // eslint-disable-next-line no-restricted-syntax -- intentional: TUI nav fire-and-forget.
      } catch { /* ignore */ }
    }
    return `${short}${suffix}`;
  }
  if (e.type === "shell") {
    return e.content; // already "$ <cmd>"
  }
  if (e.type === "beat_completed" || e.type === "beat_failed" || e.type === "decision") {
    // Try to extract file/tool stats from detail
    if (e.detail) {
      try {
        const d = typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
        const parts: string[] = [];
        const tc = d.beatToolCalls ?? d.toolCalls ?? 0;
        const fe = d.beatFileEdits ?? d.fileEdits ?? 0;
        const sc = d.beatShellCmds ?? d.shellCmds ?? 0;
        const lc = d.linesChanged ?? 0;
        if (tc > 0) parts.push(`${tc} tools`);
        if (fe > 0) parts.push(`${fe} files`);
        if (lc > 0) parts.push(`${lc} lines`);
        if (sc > 0) parts.push(`${sc} cmds`);
        const completed = d.taskCompleted;
        const prefix = completed ? "task completed" : e.type === "beat_failed" ? "failed" : "beat done";
        if (parts.length > 0) return `${prefix}: ${parts.join(", ")}`;
         
        return prefix;
      // eslint-disable-next-line no-restricted-syntax -- intentional: TUI nav fire-and-forget.
      } catch { /* ignore */ }
    }
    return e.content;
  }
  return e.content;
}

// ---------- Component ----------

interface SprintViewProps {
  height: number;
  active: boolean;
  onEscape?: () => void;
}

export function SprintView({ height, active, onEscape }: SprintViewProps) {
  const { data: companyData, loading } = usePoll<CompanyResponse>("/api/company", 3000);
  const { data: sprintsData } = usePoll<SprintsResponse>("/api/sprints", 5000);
  const { data: historicalActivity } = usePoll<ActivityEvent[]>("/api/activity", 5000);
  const { events: activityEvents } = useThrottledActivity();
  const [cursor, setCursor] = useState(0);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  // Merge historical + live SSE events, deduplicate by id
  const beatsByTask = useMemo(() => {
    const seen = new Set<string>();
    const all: ActivityEvent[] = [];
    // Historical first (older), then live SSE (newer)
    for (const e of [...(historicalActivity ?? []), ...activityEvents]) {
      if (!e.taskId || seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
    const map = new Map<string, ActivityEvent[]>();
    for (const e of all) {
      // Skip internal agent events
      if (isInternalRole(e.employee)) continue;
      const arr = map.get(e.taskId!) ?? [];
      arr.push(e);
      map.set(e.taskId!, arr);
    }
    return map;
  }, [historicalActivity, activityEvents]);

  // Build navigable rows
  const rows = useMemo<ListRow[]>(() => {
    const result: ListRow[] = [];
    const tasks = companyData?.tasks ?? [];
    const sprints = sprintsData ?? [];
    const currentSprint = companyData?.currentSprint;

    // Group tasks by sprint
    const sprintMap = new Map<number, TaskData[]>();
    const unassigned: TaskData[] = [];

    for (const task of tasks) {
      const sn = task.sprintNumber ?? currentSprint?.number;
      if (sn != null) {
        const arr = sprintMap.get(sn) ?? [];
        arr.push(task);
        sprintMap.set(sn, arr);
      } else {
        unassigned.push(task);
      }
    }

    // Render sprint sections
    const sprintNumbers = [...sprintMap.keys()].sort((a, b) => b - a);
    for (const sn of sprintNumbers) {
      const sprint = sprints.find((s) => s.number === sn) ?? currentSprint ?? { number: sn, title: `Sprint #${sn}` };
      result.push({ kind: "sprint-header", sprint });

      const sprintTasks = sprintMap.get(sn) ?? [];
      for (const task of sprintTasks) {
        const taskBeats = beatsByTask.get(task.id) ?? [];
        result.push({ kind: "task", task, beatCount: taskBeats.length, lastBeatTime: taskBeats[taskBeats.length - 1]?.timestamp });

        // If expanded, show beats and errors
        if (expandedTasks.has(task.id)) {
          const ACTION_TYPES = new Set(["tool_call", "file_edit", "shell", "beat_completed", "beat_failed", "error", "transition", "decision"]);
          const relevant = taskBeats.filter((b) => ACTION_TYPES.has(b.type));
          for (const evt of relevant.slice(-20)) {
            result.push({ kind: "beat", event: evt, taskId: task.id });
          }
        }
      }
    }

    // Unassigned tasks
    if (unassigned.length > 0) {
      result.push({ kind: "sprint-header", sprint: { title: "Backlog" } });
      for (const task of unassigned) {
        const taskBeats = beatsByTask.get(task.id) ?? [];
        result.push({ kind: "task", task, beatCount: taskBeats.length, lastBeatTime: taskBeats[taskBeats.length - 1]?.timestamp });
        if (expandedTasks.has(task.id)) {
          const ACTION_TYPES = new Set(["tool_call", "file_edit", "shell", "beat_completed", "beat_failed", "error", "transition", "decision"]);
          for (const evt of taskBeats.filter((b) => ACTION_TYPES.has(b.type)).slice(-20)) {
            result.push({ kind: "beat", event: evt, taskId: task.id });
          }
        }
      }
    }

    return result;
  }, [companyData, sprintsData, expandedTasks, beatsByTask]);

  // Keep cursor in bounds
  const maxCursor = Math.max(0, rows.length - 1);
  const safeCursor = Math.min(cursor, maxCursor);

  useInput(
    (ch, key) => {
      if (!active) return;

      if (key.escape) {
        onEscape?.();
        return;
      }

      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(maxCursor, c + 1));
        return;
      }

      if (key.return) {
        const row = rows[safeCursor];
        if (row?.kind === "task") {
          setExpandedTasks((prev) => {
            const next = new Set(prev);
            if (next.has(row.task.id)) next.delete(row.task.id);
            else next.add(row.task.id);
            return next;
          });
        }
        return;
      }
    },
    { isActive: active },
  );

  if (loading && rows.length === 0) {
    return (
      <Box><Spinner /><Text dimColor> Loading sprint data...</Text></Box>
    );
  }

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>  No sprints or tasks yet. Start a build first.</Text>
      </Box>
    );
  }

  // Window around cursor
  const windowSize = Math.max(height - 1, 5);
  const windowStart = Math.max(0, Math.min(safeCursor - Math.floor(windowSize / 2), rows.length - windowSize));
  const visible = rows.slice(windowStart, windowStart + windowSize);

  return (
    <Box flexDirection="column" height={height}>
      {visible.map((row, i) => {
        const globalIdx = windowStart + i;
        const isCursor = globalIdx === safeCursor;
        const pointer = isCursor && active ? "▸ " : "  ";

        if (row.kind === "sprint-header") {
          return (
            <Box key={`sprint-${row.sprint.number ?? "backlog"}`}>
              <Text color="cyan" bold>
                {"── "}
                {row.sprint.number != null ? `Sprint #${row.sprint.number}` : row.sprint.title}
                {row.sprint.title && row.sprint.number != null ? `: ${row.sprint.title}` : ""}
                {row.sprint.status ? ` [${row.sprint.status}]` : ""}
                {" ──"}
              </Text>
            </Box>
          );
        }

        if (row.kind === "task") {
          const t = row.task;
          const expanded = expandedTasks.has(t.id);
          const color = taskStatusColor(t.status);
          return (
            <Box key={t.id}>
              <Text color={isCursor ? "cyan" : "gray"}>{pointer}</Text>
              <Text color={color}>{statusGlyph(t.status)} </Text>
              {t.assignedRole && (
                <Text color={roleColor(t.assignedRole)} bold>{roleShort(t.assignedRole)} </Text>
              )}
              <Box flexGrow={1}>
                <Text color={color} wrap="truncate-end">{t.title}</Text>
              </Box>
              {expanded && <Text dimColor> ▾</Text>}
              {row.beatCount > 0 && <Text dimColor> ({row.beatCount})</Text>}
              {row.lastBeatTime && <Text dimColor> {formatTime(row.lastBeatTime)}</Text>}
            </Box>
          );
        }

        if (row.kind === "beat") {
          const e = row.event;
          const label = formatBeatLabel(e);
          const glyph = e.type === "decision" ? (label.startsWith("task completed") ? "◆" : "·") : beatGlyph(e.type);
          const color = e.type === "decision" && label.startsWith("task completed") ? "green" : beatColor(e.type);
          return (
            <Box key={e.id}>
              <Text>{"     "}</Text>
              <Text color={color}>{glyph} </Text>
              <Text color={roleColor(e.employee)} dimColor>{roleShort(e.employee)}</Text>
              <Text dimColor> </Text>
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">{label}</Text>
              </Box>
              <Text dimColor> {formatTime(e.timestamp)}</Text>
            </Box>
          );
        }

        if (row.kind === "error-detail") {
          return (
            <Box key={`err-${row.taskId}-${i}`}>
              <Text>{"     "}</Text>
              <Text color="red">  ! </Text>
              <Box flexGrow={1}>
                <Text color="red" wrap="truncate-end">{row.text}</Text>
              </Box>
            </Box>
          );
        }

        return null;
      })}
    </Box>
  );
}
