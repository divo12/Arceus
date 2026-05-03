import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { useCeoChat } from "../hooks/use-ceo-chat.js";
import { Spinner } from "../components/spinner.js";
import type { ChatMessage } from "@arceus/contracts";

interface CeoChatViewProps {
  height: number;
  /** When true this view captures keyboard input */
  active: boolean;
}

const ROLE_COLORS: Record<string, string> = {
  board: "cyan",
  ceo: "yellow",
  system: "gray",
  agent: "green",
};

const ROLE_LABELS: Record<string, string> = {
  board: "You",
  ceo: "CEO",
  system: "SYS",
  agent: "Agent",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return "";
  }
}

function MessageRow({ msg }: { msg: ChatMessage }) {
  const color = ROLE_COLORS[msg.role] ?? "white";
  const label = ROLE_LABELS[msg.role] ?? msg.role;
  const time = formatTime(msg.createdAt);
  const badge = msg.cardType ? ` [${msg.cardType}]` : "";

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text dimColor>{time} </Text>
        <Text bold color={color}>
          {label}
        </Text>
        {badge && <Text color="magenta">{badge}</Text>}
      </Box>
      <Box marginLeft={6}>
        <Text wrap="wrap">{msg.content}</Text>
      </Box>
    </Box>
  );
}

export function CeoChatView({ height, active }: CeoChatViewProps) {
  const { messages, streaming, streamText, error, send } = useCeoChat();
  const [input, setInput] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);

  // Blink cursor
  useEffect(() => {
    const iv = setInterval(() => { setCursorVisible((v) => !v); }, 530);
    return () => { clearInterval(iv); };
  }, []);

  useInput(
    (ch, key) => {
      if (!active) return;

      if (key.return) {
        if (input.trim() && !streaming) {
          send(input.trim());
          setInput("");
        }
        return;
      }

      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }

      // Ignore control keys
      if (key.ctrl || key.meta || key.escape) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.tab) return;

      if (ch) {
        setInput((prev) => prev + ch);
      }
    },
    { isActive: active },
  );

  // Reserve lines for the input area
  const inputAreaHeight = 3;
  const chatAreaHeight = Math.max(height - inputAreaHeight, 3);

  // Determine visible messages (most recent that fit)
  const visibleMessages = messages.slice(-chatAreaHeight);

  return (
    <Box flexDirection="column" height={height}>
      {/* Chat history area */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.length === 0 && !streaming && (
          <Box flexDirection="column" paddingLeft={1}>
            <Text color="yellow">Chat with your CEO agent.</Text>
            <Text dimColor>Type a message below and press Enter to send.</Text>
          </Box>
        )}

        {visibleMessages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}

        {/* Streaming response */}
        {streaming && streamText && (
          <Box flexDirection="column" marginBottom={0}>
            <Box>
              <Text bold color="yellow">
                CEO
              </Text>
              <Text dimColor> (streaming)</Text>
            </Box>
            <Box marginLeft={6}>
              <Text wrap="wrap">{streamText}</Text>
            </Box>
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

      {/* Input area */}
      <Box flexDirection="column">
        <Box>
          <Text color="gray">{"─".repeat(72)}</Text>
        </Box>
        <Box>
          <Text color="cyan" bold>
            {"› "}
          </Text>
          <Text>{input}</Text>
          <Text color="cyan">{cursorVisible ? "█" : " "}</Text>
          {streaming && (
            <Box marginLeft={2}>
              <Text dimColor>(streaming...)</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
