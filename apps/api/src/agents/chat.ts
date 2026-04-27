import type { FastifyReply } from "fastify";
import { buildCeoOperatingPrompt, classifyCeoResponse, generateStrategy, type CeoCard } from "./ceo.js";
import { appendChatMessage } from "../persistence/store.js";
import { getActiveCompanyId, requireActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { ensureDeployment } from "../config/index.js";
import { getCeoSession, openOpencodeEventStream, postOpencodeJson } from "../infra/opencode.js";
import { getExecutionStatus } from "../orchestration/state.js";
import { recordCeoCardMeeting } from "../meetings/recording.js";
import type { ChatMessage, CompanySnapshot } from "@arceus/contracts";
import { bootstrapIdeaWithWorkspace } from "../orchestration/bootstrap.js";
import { emitBeatEvent } from "@arceus/company-runtime";

/** Guard: set while CEO is streaming a live chat response. */
let ceoStreaming = false;
/** Returns whether the CEO agent is currently streaming a response. */
export function isCeoStreaming(): boolean { return ceoStreaming; }

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

function appendConversationMessage(snapshot: CompanySnapshot, role: ChatMessage["role"], content: string, card: CeoCard | null = null) {
  return appendChatMessage({
    id: `chat_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    sprintId: snapshot.company.currentSprintId,
    agentId: null,
    role,
    content,
    cardType: card?.card_type ?? null,
    cardData: card ? card : null,
    createdAt: new Date().toISOString(),
  });
}

async function startCeoPromptAsync(message: string, snapshot: CompanySnapshot) {
  const session = await getCeoSession();
  const deployment = ensureDeployment("ceoDeployment");

  await postOpencodeJson(`/session/${session.id}/prompt_async`, {
    model: { providerID: "azure", modelID: deployment },
    agent: "ceo",
    system: buildCeoOperatingPrompt(snapshot, getExecutionStatus()),
    parts: [{ type: "text", text: message }]
  });

  return session.id;
}

/**
 * Stream a board message to the CEO agent via SSE.
 * Handles bootstrapping, classification, and meeting recording.
 */
export async function streamBoardMessageToCeo(reply: FastifyReply, message: string) {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error("CEO chat message cannot be empty.");
  }

  ceoStreaming = true;
  try {
    // Spec 31 Phase 7.C.c — bootstrap if needed, then assemble the
    // snapshot from canonical for CEO prompt context.
    let snapshot: CompanySnapshot;
    if (!getActiveCompanyId()) {
      snapshot = (await bootstrapIdeaWithWorkspace(trimmedMessage)).snapshot;
    } else {
      snapshot = await buildSnapshotView(requireActiveCompanyId());
    }

  appendConversationMessage(snapshot, "board", trimmedMessage);
  snapshot = await buildSnapshotView(requireActiveCompanyId());

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Access-Control-Allow-Origin", reply.request.headers.origin || "*");
  reply.raw.setHeader("Access-Control-Allow-Credentials", "true");

  sseWrite(reply, "board", { content: trimmedMessage });
  sseWrite(reply, "status", { phase: "connecting" });

  const reader = await openOpencodeEventStream();
  let buffer = "";
  let targetMessageId: string | null = null;
  const sessionId = await startCeoPromptAsync(trimmedMessage, snapshot);
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

    let nextSnapshot = await buildSnapshotView(requireActiveCompanyId());
    if (fullText) {
      try {
        sseWrite(reply, "status", { phase: "classifying" });
        const card = await classifyCeoResponse(fullText, nextSnapshot, getExecutionStatus());
        // Spec 01: No side effects during ideation. Meetings and tasks are only
        // created after strategy approval when the company is active with agents.
        const meeting = await recordCeoCardMeeting(card, trimmedMessage, fullText);
        // Re-read after recordCeoCardMeeting may have appended tasks/meetings.
        const postMeetingSnapshot = await buildSnapshotView(requireActiveCompanyId());
        appendConversationMessage(postMeetingSnapshot, "ceo", fullText, card);
        if (meeting) {
          sseWrite(reply, "meeting", {
            meetingId: meeting.id,
            summary: meeting.title,
            type: meeting.type,
            taskDeltaCount: meeting.resolutions?.decisions.filter(d => d.taskAction).length ?? 0,
            memoryDeltaCount: 0,
          });
        }
        nextSnapshot = await buildSnapshotView(requireActiveCompanyId());
        sseWrite(reply, "proposal", card);
      } catch (cardErr) {
        const errorSnapshot = await buildSnapshotView(requireActiveCompanyId());
        appendConversationMessage(errorSnapshot, "ceo", fullText);
        nextSnapshot = errorSnapshot;
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

  // Emit board_message event so heartbeat can react
  emitBeatEvent({
    type: "board_message",
    beatId: "chat_" + Date.now(),
    agentId: "board",
    role: "ceo",
    data: { message: trimmedMessage.slice(0, 200) },
  });
  } finally {
    ceoStreaming = false;
  }
}

/** Send a board message to the CEO and return a structured strategy card (non-streaming). */
export async function sendBoardMessageToCeo(message: string) {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error("CEO chat message cannot be empty.");
  }

  // Spec 31 Phase 7.C.c — bootstrap if needed, then read from canonical.
  let snapshot: CompanySnapshot;
  if (!getActiveCompanyId()) {
    snapshot = (await bootstrapIdeaWithWorkspace(trimmedMessage)).snapshot;
  } else {
    snapshot = await buildSnapshotView(requireActiveCompanyId());
  }

  appendConversationMessage(snapshot, "board", trimmedMessage);
  snapshot = await buildSnapshotView(requireActiveCompanyId());

  const strategy = await generateStrategy(snapshot);
  const assistantMessage = [strategy.summary, `First release: ${strategy.first_release}`].join("\n\n");
  const card: CeoCard = {
    card_type: "strategy_proposal" as const,
    stage: "kickoff",
    title: strategy.strategy_title,
    summary: strategy.summary,
    welcome: null,
    mission: null,
    strategy: {
      first_release: strategy.first_release,
      scope_boundary: strategy.scope_boundary,
      role_rationale: strategy.role_rationale,
      roles: strategy.roles,
      execution_sequence: [
        "Approve the first release and initial org chart.",
        "Have the CTO break execution into taskable work.",
        "Run the first implementation cycle and review the preview.",
      ],
      board_checkpoints: [
        "Confirm the target user and first-release scope.",
        "Review delivery progress and the first runnable preview.",
        "Approve launch-readiness or tighten scope.",
      ],
      key_risks: [
        "Scope could sprawl if the board keeps adding first-release requirements.",
        "The team shape may be too heavy unless each role has a clear delivery edge.",
        "Launch quality will slip if preview validation is deferred too late.",
      ],
    },
    question: null,
    status: null,
    sprint_proposal: null,
    meeting: {
      create: true,
      type: "ad_hoc" as const,
      summary: `CEO proposed a strategy for ${snapshot.company.name || "the company"}.`,
      rationale: "The strategy proposal should be reviewed as a formal CEO meeting before approval or execution.",
      task_deltas: [],
    },
  };

  const postSnapshot = await buildSnapshotView(requireActiveCompanyId());
  appendConversationMessage(postSnapshot, "ceo", assistantMessage, card);

  return {
    assistantMessage,
    strategy,
    card,
    snapshot: await buildSnapshotView(requireActiveCompanyId()),
  };
}
