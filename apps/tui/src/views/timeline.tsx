import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { roleColor, roleShort } from "../theme.js";
import { useActivity, type ActivityEvent } from "../hooks/use-activity.js";
import { useAudit, type AuditEvent } from "../hooks/use-audit.js";
import { useCeoChat } from "../hooks/use-ceo-chat.js";
import { Spinner } from "../components/spinner.js";
import { api } from "../api/client.js";
import type { ChatMessage } from "@arceus/contracts";

/** Unified entry for the build stream. */
interface StreamEntry {
  id: string;
  time: string;       // ISO string for sorting
  kind: "chat" | "beat" | "audit";
  role: string;
  glyph: string;
  color: string;
  text: string;
  tag?: string;
  /** For chat messages: the card type badge */
  badge?: string;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return "??:??:??";
  }
}

// ---------- Role-grouped beat panel ----------

const ROLES = ["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"] as const;

interface BeatGroup {
  beatId: string;
  role: string;
  status: "running" | "completed" | "failed" | "idle";
  startedAt: string;
  summary: string;
  events: ActivityEvent[];
}

function statusGlyph(status: BeatGroup["status"]): string {
  switch (status) {
    case "running":   return "▶";
    case "completed": return "✓";
    case "failed":    return "✗";
    case "idle":      return "·";
  }
}

function statusColor(status: BeatGroup["status"]): string {
  switch (status) {
    case "running":   return "yellow";
    case "completed": return "green";
    case "failed":    return "red";
    case "idle":      return "gray";
  }
}

/** Build flat list of (role-header | beat-row) for cursor navigation */
interface PanelRow {
  kind: "role-header" | "beat";
  role: string;
  beat?: BeatGroup;
  beatCount?: number;
}

function buildBeatGroups(events: ActivityEvent[]): Map<string, BeatGroup[]> {
  const byRole = new Map<string, Map<string, BeatGroup>>();

  for (const e of events) {
    if (!e.beatId) continue;
    const role = e.employee;
    if (!byRole.has(role)) byRole.set(role, new Map());
    const roleBeats = byRole.get(role)!;

    if (!roleBeats.has(e.beatId)) {
      roleBeats.set(e.beatId, {
        beatId: e.beatId,
        role,
        status: "running",
        startedAt: e.timestamp,
        summary: "",
        events: [],
      });
    }

    const group = roleBeats.get(e.beatId)!;
    group.events.push(e);

    if (e.type === "beat_completed") { group.status = "completed"; group.summary = e.content; }
    else if (e.type === "beat_failed")    { group.status = "failed";    group.summary = e.content; }
    else if (e.type === "beat_idle")      { group.status = "idle";      group.summary = e.content; }
  }

  const result = new Map<string, BeatGroup[]>();
  for (const role of ROLES) {
    const roleBeats = byRole.get(role);
    if (roleBeats && roleBeats.size > 0) {
      result.set(role, [...roleBeats.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    }
  }
  return result;
}

function buildPanelRows(groups: Map<string, BeatGroup[]>): PanelRow[] {
  const rows: PanelRow[] = [];
  for (const role of ROLES) {
    const beats = groups.get(role);
    if (!beats || beats.length === 0) continue;
    rows.push({ kind: "role-header", role, beatCount: beats.length });
    for (const beat of beats) {
      rows.push({ kind: "beat", role, beat });
    }
  }
  return rows;
}

// ---------- Activity event mapping ----------

function activityGlyph(type: string): string {
  switch (type) {
    case "beat_started":   return "▶";
    case "beat_completed": return "✓";
    case "beat_failed":    return "✗";
    case "beat_idle":      return "·";
    case "working":        return "⚡";
    case "file_edit":      return "📝";
    case "shell":          return "$";
    case "tool_call":      return "🔧";
    case "error":          return "✗";
    default:               return "│";
  }
}

function activityColor(type: string): string {
  switch (type) {
    case "beat_completed":          return "green";
    case "beat_failed": case "error": return "red";
    case "beat_started": case "working": return "yellow";
    case "beat_idle":               return "gray";
    case "file_edit":               return "cyan";
    case "tool_call":               return "magenta";
    default:                        return "white";
  }
}

function mapActivity(e: ActivityEvent): StreamEntry {
  return {
    id: e.id,
    time: e.timestamp,
    kind: "beat",
    role: e.employee,
    glyph: activityGlyph(e.type),
    color: activityColor(e.type),
    text: e.content,
    tag: e.taskId ?? e.beatId,
  };
}

// ---------- Audit event mapping ----------

function auditGlyph(eventType: string): string {
  if (eventType.includes("tool"))    return "🔧";
  if (eventType.includes("task"))    return "☐";
  if (eventType.includes("meeting")) return "◎";
  if (eventType.includes("error") || eventType.includes("fail")) return "✗";
  if (eventType.includes("sprint")) return "⟳";
  if (eventType.includes("board"))  return "▸";
  return "·";
}

function auditColor(severity: string): string {
  switch (severity) {
    case "error":   return "red";
    case "warning": return "yellow";
    case "success": return "green";
    default:        return "gray";
  }
}

function mapAudit(e: AuditEvent): StreamEntry {
  return {
    id: e.id,
    time: e.occurredAt,
    kind: "audit",
    role: e.agentRole ?? "system",
    glyph: auditGlyph(e.eventType),
    color: auditColor(e.severity),
    text: e.summary,
    tag: e.beatId,
  };
}

// ---------- Chat message mapping ----------

const CHAT_GLYPHS: Record<string, string> = {
  board: "›",
  ceo: "◆",
  system: "·",
  agent: "▸",
};

function mapChat(msg: ChatMessage): StreamEntry {
  return {
    id: msg.id,
    time: msg.createdAt,
    kind: "chat",
    role: msg.role,
    glyph: CHAT_GLYPHS[msg.role] ?? "·",
    color: msg.role === "board" ? "cyan" : msg.role === "ceo" ? "yellow" : "gray",
    text: msg.content,
    badge: msg.cardType ?? undefined,
  };
}

// ---------- Component ----------

interface TimelineViewProps {
  height: number;
  /** When true, this view captures keyboard input for the chat prompt */
  active: boolean;
  /** Called when Escape is pressed — yields keyboard focus to app-level shortcuts */
  onEscape?: () => void;
  /** Called on Enter — posts idea to /api/quick-execute */
  onQuickExecute?: (idea: string) => void;
  /** Called on /reset — stops heartbeat before clearing */
  onStop?: () => void;
}

export function TimelineView({ height, active, onEscape, onQuickExecute, onStop }: TimelineViewProps) {
  const { events: activityEvents, connected: actConn, clear: clearActivity } = useActivity();
  const { events: auditEvents, connected: audConn, clear: clearAudit } = useAudit();
  const { messages, streaming, streamText, error, send, refreshHistory, clearMessages } = useCeoChat();
  const [input, setInput] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);
  const [resetting, setResetting] = useState(false);

  // Beat panel state — cursor + expansion
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Focus: "input" = typing in prompt, "beats" = navigating beat panel
  const [focus, setFocus] = useState<"input" | "beats">("input");

  // Build beat groups from activity events
  const beatGroups = useMemo(() => buildBeatGroups(activityEvents), [activityEvents]);
  const panelRows = useMemo(() => buildPanelRows(beatGroups), [beatGroups]);

  // Blink cursor
  useEffect(() => {
    const iv = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(iv);
  }, []);

  // Keep cursor in bounds
  useEffect(() => {
    if (panelRows.length > 0 && cursor >= panelRows.length) {
      setCursor(panelRows.length - 1);
    }
  }, [panelRows.length, cursor]);

  useInput(
    (ch, key) => {
      if (!active) return;

      // Tab toggles focus between input and beats panel
      if (key.tab) {
        setFocus((f) => f === "input" ? "beats" : "input");
        return;
      }

      // Escape from beats panel goes back to input
      if (key.escape) {
        if (focus === "beats") {
          setFocus("input");
          return;
        }
        onEscape?.();
        return;
      }

      // ---- Beats panel mode ----
      if (focus === "beats") {
        if (key.upArrow) {
          setCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow) {
          setCursor((c) => Math.min(panelRows.length - 1, c + 1));
          return;
        }
        if (key.return) {
          const row = panelRows[cursor];
          if (row?.kind === "beat" && row.beat) {
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(row.beat!.beatId)) next.delete(row.beat!.beatId);
              else next.add(row.beat!.beatId);
              return next;
            });
          }
          return;
        }
        // Any other key in beats mode — ignore
        return;
      }

      // ---- Input mode ----
      if (key.return) {
        const trimmed = input.trim();
        if (!trimmed || streaming) return;

        if (trimmed === "/reset") {
          setInput("");
          setResetting(true);
          onStop?.();
          clearMessages();
          clearActivity();
          clearAudit();
          // eslint-disable-next-line no-restricted-syntax -- intentional: TUI timeline fire-and-forget. (Also slated for deletion per knip Tier 3.)
          api("/api/company", { method: "DELETE" })
            .then(() => { refreshHistory(); })
            .catch(() => {})
            .finally(() => { setResetting(false); });
          return;
        }

        if (trimmed.startsWith("/run")) {
          const msg = trimmed.slice(4).trim();
          if (msg) {
            setInput("");
            onQuickExecute?.(msg);
          }
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

      if (ch) {
        setInput((prev) => prev + ch);
      }
    },
    { isActive: active },
  );

  const connected = actConn || audConn;

  // Filter to only important events for the main panel
  const IMPORTANT_ACTIVITY = new Set([
    "beat_completed", "beat_failed", "error",
  ]);
  const IMPORTANT_AUDIT = new Set([
    "task_created", "task_completed", "task_failed",
    "sprint_proposed", "sprint_approved", "sprint_started", "sprint_completed",
    "artifact_created", "meeting_completed",
    "approval_requested", "approval_resolved",
  ]);

  const important: StreamEntry[] = [
    ...messages.map(mapChat),
    ...activityEvents
      .filter((e) => IMPORTANT_ACTIVITY.has(e.type))
      .map(mapActivity),
    ...auditEvents
      .filter((e) => IMPORTANT_AUDIT.has(e.eventType))
      .map(mapAudit),
  ].sort((a, b) => a.time.localeCompare(b.time));

  // Layout — reserve input area, split remaining between panels
  const inputAreaHeight = 3;
  const contentHeight = Math.max(height - inputAreaHeight, 4);

  // Left panel: important events — show most recent
  const streamVisible = important.slice(-contentHeight);

  // Right panel: beat rows — window around cursor
  const beatPanelHeight = contentHeight - 1; // -1 for header
  const beatStart = 0;
  // Count total rendered rows including expanded beats
  const renderedRows: Array<{ row: PanelRow; idx: number; expandedEvents?: ActivityEvent[] }> = [];
  for (let i = 0; i < panelRows.length; i++) {
    const row = panelRows[i];
    renderedRows.push({ row, idx: i });
    if (row.kind === "beat" && row.beat && expanded.has(row.beat.beatId)) {
      renderedRows.push(...row.beat.events.map((e) => ({
        row: { kind: "detail" as any, role: row.role } as PanelRow,
        idx: i,
        expandedEvents: [e],
      })));
    }
  }

  // Find cursor position in rendered rows
  const cursorRenderedIdx = renderedRows.findIndex((r) => r.idx === cursor && r.row === panelRows[cursor]);
  const windowStart = Math.max(0, Math.min(cursorRenderedIdx - Math.floor(beatPanelHeight / 2), renderedRows.length - beatPanelHeight));
  const visibleBeatRows = renderedRows.slice(Math.max(0, windowStart), Math.max(0, windowStart) + beatPanelHeight);

  return (
    <Box flexDirection="column" height={height}>
      {/* Header bar */}
      <Box>
        <Text bold color="yellow">Build</Text>
        <Text color="gray"> │ </Text>
        <Text color={actConn ? "green" : "red"}>{actConn ? "●" : "○"} beats</Text>
        <Text color="gray">  </Text>
        <Text color={audConn ? "green" : "red"}>{audConn ? "●" : "○"} audit</Text>
        <Text color="gray"> │ </Text>
        <Text dimColor>Tab:switch panel  </Text>
        <Text color={focus === "beats" ? "cyan" : "gray"}>[{focus === "beats" ? "beats" : "input"}]</Text>
      </Box>

      {/* Split: main events (left) | beats panel (right) */}
      <Box flexGrow={1}>
        {/* Left: Important events */}
        <Box flexDirection="column" width="50%" paddingRight={1}>
          {!connected && important.length === 0 && (
            <Box>
              <Text color="yellow">Connecting...</Text>
            </Box>
          )}

          {connected && important.length === 0 && !streaming && (
            <Box flexDirection="column">
              <Text color="yellow">Type what to build and press Enter.</Text>
            </Box>
          )}

          {streamVisible.map((entry) => (
            <Box key={entry.id}>
              <Text dimColor>[{formatTime(entry.time)}] </Text>
              {entry.kind === "chat" ? (
                <>
                  <Text color={entry.color} bold>
                    {entry.role === "board" ? "You" : entry.role === "ceo" ? "CEO" : roleShort(entry.role)}
                  </Text>
                  {entry.badge && <Text color="magenta"> [{entry.badge}]</Text>}
                </>
              ) : (
                <>
                  <Text color={roleColor(entry.role)} bold>{roleShort(entry.role)}</Text>
                  <Text color={entry.color}> {entry.glyph}</Text>
                </>
              )}
              <Text> </Text>
              <Text color={entry.color} wrap="truncate-end">
                {entry.text.length > 60 ? entry.text.slice(0, 57) + "..." : entry.text}
              </Text>
            </Box>
          ))}

          {streaming && streamText && (
            <Box>
              <Text bold color="yellow">CEO </Text>
              <Text color="yellow" wrap="truncate-end">
                {streamText.length > 60 ? streamText.slice(0, 57) + "..." : streamText}
              </Text>
            </Box>
          )}

          {streaming && !streamText && (
            <Box>
              <Spinner />
              <Text dimColor> CEO is thinking...</Text>
            </Box>
          )}

          {error && <Text color="red">Error: {error}</Text>}
        </Box>

        {/* Right: Role-grouped beat panel */}
        <Box flexDirection="column" width="50%" borderStyle="single" borderColor={focus === "beats" ? "cyan" : "gray"}>
          {panelRows.length === 0 ? (
            <Box paddingLeft={1}>
              <Text dimColor>No beats yet — press Enter to start</Text>
            </Box>
          ) : (
            visibleBeatRows.map((item, vi) => {
              if (item.expandedEvents) {
                // Expanded detail row
                const e = item.expandedEvents[0];
                return (
                  <Box key={`detail-${e.id}`} paddingLeft={6}>
                    <Text dimColor>{formatTime(e.timestamp)} </Text>
                    <Text color={activityColor(e.type)}>{activityGlyph(e.type)} </Text>
                    <Text color="gray" wrap="truncate-end">{e.content.slice(0, 50)}</Text>
                  </Box>
                );
              }

              const { row, idx } = item;
              const isCursorRow = idx === cursor;

              if (row.kind === "role-header") {
                return (
                  <Box key={`rh-${row.role}`}>
                    <Text color={isCursorRow && focus === "beats" ? "cyan" : "gray"}>{isCursorRow && focus === "beats" ? "▸ " : "  "}</Text>
                    <Text color={roleColor(row.role)} bold>{roleShort(row.role)}</Text>
                    <Text dimColor> ({row.beatCount})</Text>
                  </Box>
                );
              }

              const beat = row.beat!;
              const isExpanded = expanded.has(beat.beatId);
              return (
                <Box key={beat.beatId}>
                  <Text color={isCursorRow && focus === "beats" ? "cyan" : "gray"}>
                    {isCursorRow && focus === "beats" ? "  ▸ " : "    "}
                  </Text>
                  <Text color={statusColor(beat.status)}>{statusGlyph(beat.status)} </Text>
                  <Text dimColor>{formatTime(beat.startedAt)} </Text>
                  <Text color="white" wrap="truncate-end">{beat.beatId.slice(0, 12)}</Text>
                  {isExpanded && <Text dimColor> ▾</Text>}
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      {/* Input prompt */}
      <Box flexDirection="column">
        <Box>
          <Text color={focus === "input" ? "cyan" : "gray"}>{"› "}</Text>
          <Text>{input}</Text>
          <Text color="cyan">{focus === "input" && cursorVisible ? "█" : " "}</Text>
          {streaming ? (
            <Box marginLeft={2}><Text dimColor>(streaming...)</Text></Box>
          ) : resetting ? (
            <Box marginLeft={2}><Spinner /><Text dimColor> resetting...</Text></Box>
          ) : input.trim() ? (
            <Box marginLeft={2}><Text dimColor>Enter:execute  /reset</Text></Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
