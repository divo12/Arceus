import type { FastifyReply } from "fastify";
import { classifyCeoResponse, generateStrategy } from "./ceo";
import { bootstrapCompany, deriveCompanyNameFromIdea, getSnapshot } from "./store";
import { ensureDeployment } from "./config";
import { getCeoSession, openOpencodeEventStream, postOpencodeJson } from "./opencode";
import { getRoleSoul } from "@arceus/company-runtime";
import { recordCeoCardMeeting } from "./orchestrator";

type OpenCodeEvent = {
  type: string;
  properties?: {
    info?: {
      id: string;
      sessionID: string;
      role: string;
      time?: {
        created?: number;
        completed?: number;
      };
    };
    part?: {
      id: string;
      sessionID: string;
      messageID: string;
      type: string;
      text?: string;
    };
    sessionID?: string;
    error?: {
      message?: string;
    };
  };
};

function sseWrite(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: string) {
  let nextBuffer = buffer;

  while (!nextBuffer.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      return { event: null, buffer: nextBuffer, done: true };
    }

    nextBuffer += new TextDecoder().decode(chunk.value, { stream: true });
  }

  const separatorIndex = nextBuffer.indexOf("\n\n");
  const rawEvent = nextBuffer.slice(0, separatorIndex);
  const remainder = nextBuffer.slice(separatorIndex + 2);
  const dataLine = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");

  if (!dataLine) {
    return { event: null, buffer: remainder, done: false };
  }

  return {
    event: JSON.parse(dataLine) as OpenCodeEvent,
    buffer: remainder,
    done: false
  };
}

async function startCeoPromptAsync(message: string) {
  const session = await getCeoSession();
  const deployment = ensureDeployment("ceoDeployment");
  const ceoSoul = getRoleSoul("ceo");

  await postOpencodeJson(`/session/${session.id}/prompt_async`, {
    model: { providerID: "azure", modelID: deployment },
    agent: "ceo",
    system: ceoSoul.systemPrompt,
    parts: [{ type: "text", text: message }]
  });

  return session.id;
}

export async function streamBoardMessageToCeo(reply: FastifyReply, message: string) {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error("CEO chat message cannot be empty.");
  }

  let snapshot = getSnapshot();

  if (snapshot.company.id === "company_pending") {
    snapshot = bootstrapCompany({
      companyName: deriveCompanyNameFromIdea(trimmedMessage),
      boardOwner: "Board",
      idea: trimmedMessage,
      budgetCents: 0
    });
  }

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");

  sseWrite(reply, "board", { content: trimmedMessage });
  sseWrite(reply, "status", { phase: "connecting" });

  const reader = await openOpencodeEventStream();
  let buffer = "";
  let targetMessageId: string | null = null;
  const sessionId = await startCeoPromptAsync(trimmedMessage);
  let fullText = "";

  sseWrite(reply, "status", { phase: "running" });

  try {
    while (true) {
      const result = await readSseEvent(reader, buffer);
      buffer = result.buffer;

      if (result.done) {
        break;
      }

      const event = result.event;
      if (!event) {
        continue;
      }

      if (event.type === "message.updated") {
        const info = event.properties?.info;
        if (info?.sessionID === sessionId && info.role === "assistant" && !targetMessageId) {
          targetMessageId = info.id;
        }
      }

      if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        if (part?.sessionID === sessionId && part.messageID === targetMessageId && part.type === "text" && typeof part.text === "string") {
          fullText = part.text;
          sseWrite(reply, "token", { content: fullText });
        }
      }

      if (event.type === "session.error" && event.properties?.sessionID === sessionId) {
        const errMsg = event.properties?.error?.message ?? "OpenCode CEO session failed.";
        sseWrite(reply, "error", { message: errMsg });
        break;
      }

      if (event.type === "session.idle" && event.properties?.sessionID === sessionId) {
        break;
      }
    }

    let nextSnapshot = getSnapshot();
    if (nextSnapshot.company.goal && fullText) {
      try {
        sseWrite(reply, "status", { phase: "classifying" });
        const card = await classifyCeoResponse(fullText, nextSnapshot);
        const meeting = recordCeoCardMeeting(card, trimmedMessage, fullText);
        if (meeting) {
          sseWrite(reply, "meeting", {
            meetingId: meeting.id,
            summary: meeting.summary,
            type: meeting.type,
            taskDeltaCount: meeting.taskModifications.length,
            memoryDeltaCount: meeting.memoryModifications.length,
          });
          nextSnapshot = getSnapshot();
        }
        sseWrite(reply, "proposal", card);
      } catch (cardErr) {
        sseWrite(reply, "error", {
          message: cardErr instanceof Error ? cardErr.message : "Card classification failed"
        });
      }
    }

    sseWrite(reply, "done", {
      content: fullText,
      snapshot: nextSnapshot
    });
  } catch (streamErr) {
    const errMsg = streamErr instanceof Error ? streamErr.message : "Unknown streaming error";
    try {
      sseWrite(reply, "error", { message: errMsg });
    } catch { /* stream already broken */ }
  } finally {
    reader.releaseLock();
    try { reply.raw.end(); } catch { /* already ended */ }
  }
}

export async function sendBoardMessageToCeo(message: string) {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error("CEO chat message cannot be empty.");
  }

  let snapshot = getSnapshot();

  if (snapshot.company.id === "company_pending") {
    snapshot = bootstrapCompany({
      companyName: deriveCompanyNameFromIdea(trimmedMessage),
      boardOwner: "Board",
      idea: trimmedMessage,
      budgetCents: 0
    });
  }

  const strategy = await generateStrategy(snapshot);
  const card = {
    card_type: "strategy_proposal" as const,
    title: strategy.strategy_title,
    summary: strategy.summary,
    strategy: {
      first_release: strategy.first_release,
      scope_boundary: strategy.scope_boundary,
      role_rationale: strategy.role_rationale,
      roles: strategy.roles,
    },
    question: null,
    meeting: {
      create: true,
      type: "ad_hoc" as const,
      summary: `CEO proposed a strategy for ${snapshot.company.name || "the company"}.`,
      rationale: "The strategy proposal should be reviewed as a formal CEO meeting before approval or execution.",
      task_deltas: [],
    },
  };

  return {
    assistantMessage: strategy.summary,
    strategy,
    card,
    snapshot,
  };
}
