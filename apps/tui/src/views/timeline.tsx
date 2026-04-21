import React, { useState, useEffect } from "react";
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
  /** Called on Ctrl+Enter — sends message and kicks off execution */
  onQuickExecute?: () => void;
}

export function TimelineView({ height, active, onEscape, onQuickExecute }: TimelineViewProps) {
  const { events: activityEvents, connected: actConn, clear: clearActivity } = useActivity();
  const { events: auditEvents, connected: audConn, clear: clearAudit } = useAudit();
  const { messages, streaming, streamText, error, send, refreshHistory, clearMessages } = useCeoChat();
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

      if (key.return) {
        const trimmed = input.trim();
        if (!trimmed || streaming) return;

        // /reset command — equivalent to the UI Reset button
        if (trimmed === "/reset") {
          setInput("");
          setResetting(true);
          // Clear local state immediately for a clean slate
          clearMessages();
          clearActivity();
          clearAudit();
          api("/api/company", { method: "DELETE" })
            .then(() => { refreshHistory(); })
            .catch(() => {})
            .finally(() => { setResetting(false); });
          return;
        }

        // /run command — send remaining text and start the heartbeat
        if (trimmed.startsWith("/run")) {
          const msg = trimmed.slice(4).trim();
          if (msg) send(msg);
          setInput("");
          onQuickExecute?.();
          return;
        }

        send(trimmed);
        setInput("");
        return;
      }

      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }

      // Ignore control keys — let app.tsx handle them
      if (key.escape) {
        onEscape?.();
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

  // Audit event types that duplicate chat messages or are system bootstrapping noise
  const AUDIT_NOISE = new Set([
    "board_message_sent",    // "Board → CEO: ..." — already shown as chat
    "board_message",         // board_message persistence event
    "chat_message",          // generic chat persistence event
    "audit_ledger_started",  // system startup noise
    "governance_hydrated",   // system startup noise
  ]);

  // Activity events that are system internals / noise in the Build stream
  function isActivityNoise(e: ActivityEvent): boolean {
    if (e.employee === "system" && e.type === "info") {
      if (e.content.startsWith("Governance:")) return true;
      if (e.content.startsWith("LLM ")) return true;
      if (e.content.startsWith("Audit ledger")) return true;
    }
    return false;
  }

  // Merge chat messages + activity + audit into one sorted stream
  const merged: StreamEntry[] = [
    ...messages.map(mapChat),
    ...activityEvents.filter((e) => !isActivityNoise(e)).map(mapActivity),
    ...auditEvents
      .filter((e) => !AUDIT_NOISE.has(e.eventType))
      .map(mapAudit),
  ].sort((a, b) => a.time.localeCompare(b.time));

  // Reserve space for input area
  const inputAreaHeight = 3;
  const streamHeight = Math.max(height - inputAreaHeight, 3);

  // Visible entries
  const visible = merged.slice(-streamHeight);

  return (
    <Box flexDirection="column" height={height}>
      {/* Stream area */}
      <Box flexDirection="column" flexGrow={1}>
        {/* Header bar */}
        <Box marginBottom={0}>
          <Text bold color="yellow">Build</Text>
          <Text color="gray"> — {merged.length} events</Text>
          <Text color="gray"> │ </Text>
          <Text color={actConn ? "green" : "red"}>{actConn ? "●" : "○"} beats</Text>
          <Text color="gray">  </Text>
          <Text color={audConn ? "green" : "red"}>{audConn ? "●" : "○"} audit</Text>
        </Box>

        {!connected && merged.length === 0 && (
          <Box>
            <Text color="yellow">Connecting to event streams...</Text>
          </Box>
        )}

        {connected && merged.length === 0 && !streaming && (
          <Box flexDirection="column" paddingLeft={1}>
            <Text color="yellow">Tell the CEO what to build.</Text>
            <Text dimColor>Type a message below and press Enter.</Text>
          </Box>
        )}

        {visible.map((entry) => (
          <Box key={entry.id}>
            <Text dimColor>[{formatTime(entry.time)}]</Text>
            <Text> </Text>
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
                <Text> </Text>
                <Text color={entry.color}>{entry.glyph}</Text>
              </>
            )}
            <Text> </Text>
            <Text color={entry.color} wrap="truncate-end">
              {entry.text.length > 100 ? entry.text.slice(0, 97) + "..." : entry.text}
            </Text>
            {entry.tag && <Text dimColor> [{entry.tag.slice(0, 8)}]</Text>}
          </Box>
        ))}

        {/* Streaming CEO response */}
        {streaming && streamText && (
          <Box>
            <Text dimColor>[{formatTime(new Date().toISOString())}]</Text>
            <Text> </Text>
            <Text bold color="yellow">CEO</Text>
            <Text> </Text>
            <Text color="yellow" wrap="truncate-end">
              {streamText.length > 100 ? streamText.slice(0, 97) + "..." : streamText}
            </Text>
          </Box>
        )}

        {streaming && !streamText && (
          <Box>
            <Spinner />
            <Text dimColor> CEO is thinking...</Text>
          </Box>
        )}

        {error && (
          <Box>
            <Text color="red">Error: {error}</Text>
          </Box>
        )}
      </Box>

      {/* Input prompt */}
      <Box flexDirection="column">
        <Box>
          <Text color="gray">{"─".repeat(72)}</Text>
        </Box>
        <Box>
          <Text color="cyan" bold>{"› "}</Text>
          <Text>{input}</Text>
          <Text color="cyan">{cursorVisible ? "█" : " "}</Text>
          {streaming ? (
            <Box marginLeft={2}>
              <Text dimColor>(streaming...)</Text>
            </Box>
          ) : resetting ? (
            <Box marginLeft={2}>
              <Spinner />
              <Text dimColor> resetting...</Text>
            </Box>
          ) : input.trim() ? (
            <Box marginLeft={2}>
              <Text dimColor>Enter:send  /run:send+execute  /reset</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
