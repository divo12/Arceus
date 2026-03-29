import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, chatMessages } from "@paperclipai/db";
import type {
  ChatMessage,
  ChatCardType,
  ChatCardData,
  ChatCardState,
  ChatMessageMetadata,
  ChatCardActionInput,
  LiveEvent,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "./heartbeat.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";

// ---------------------------------------------------------------------------
// Row → API type
// ---------------------------------------------------------------------------

function toMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role as ChatMessage["role"],
    content: row.content,
    cardType: (row.cardType as ChatCardType) ?? null,
    cardData: (row.cardData as ChatCardData) ?? null,
    cardState: (row.cardState as ChatCardState) ?? null,
    agentId: row.agentId,
    metadata: (row.metadata as ChatMessageMetadata) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// OpenCode output parser
// ---------------------------------------------------------------------------

/**
 * Extract human-readable text from OpenCode JSON-format stdout chunks.
 * OpenCode outputs JSON lines like: {"type":"text","part":{"text":"..."}}
 * We extract just the text content and ignore step_start/step_finish/system messages.
 */
function extractOpenCodeText(chunk: string): string {
  const texts: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip [paperclip] system messages
    if (trimmed.startsWith("[paperclip]")) continue;

    // Try parsing as OpenCode JSON
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "text" && parsed.part?.text) {
        texts.push(parsed.part.text);
      }
      // Ignore step_start, step_finish, and other non-text types
    } catch {
      // Not JSON — might be plain text output, include if not a system prefix
      if (!trimmed.startsWith("{")) {
        texts.push(trimmed);
      }
    }
  }
  return texts.join("");
}

// ---------------------------------------------------------------------------
// Chat service
// ---------------------------------------------------------------------------

export function chatService(db: Db) {
  const heartbeat = heartbeatService(db);

  return {
    // ---- Message history (paginated) ----

    async getHistory(companyId: string, limit = 50, before?: string): Promise<ChatMessage[]> {
      const conditions = [eq(chatMessages.companyId, companyId)];
      if (before) {
        const cursor = await db.select({ createdAt: chatMessages.createdAt }).from(chatMessages).where(eq(chatMessages.id, before)).then(r => r[0]);
        if (cursor) conditions.push(lt(chatMessages.createdAt, cursor.createdAt));
      }
      const rows = await db
        .select()
        .from(chatMessages)
        .where(and(...conditions))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
      return rows.reverse().map(toMessage);
    },

    // ---- Store a user message ----

    async storeUserMessage(companyId: string, content: string): Promise<ChatMessage> {
      const [row] = await db.insert(chatMessages).values({
        companyId,
        role: "user",
        content,
      }).returning();
      return toMessage(row);
    },

    // ---- Store an assistant message ----

    async storeAssistantMessage(
      companyId: string,
      content: string,
      agentId: string | null,
      opts?: {
        cardType?: ChatCardType;
        cardData?: ChatCardData;
        metadata?: ChatMessageMetadata;
      },
    ): Promise<ChatMessage> {
      const [row] = await db.insert(chatMessages).values({
        companyId,
        role: "assistant",
        content,
        agentId,
        cardType: opts?.cardType ?? null,
        cardData: opts?.cardData ?? null,
        metadata: opts?.metadata ?? null,
      }).returning();
      return toMessage(row);
    },

    // ---- Card action (approve/reject/edit) ----

    async updateCardState(messageId: string, action: ChatCardActionInput): Promise<ChatMessage> {
      const [row] = await db
        .update(chatMessages)
        .set({
          cardState: {
            action: action.action,
            actedAt: new Date().toISOString(),
            ...(action.editedData ? { editedData: action.editedData } : {}),
          },
        })
        .where(eq(chatMessages.id, messageId))
        .returning();
      if (!row) throw notFound("Chat message not found");
      return toMessage(row);
    },

    // ---- Build chat context markdown for agent prompt ----

    buildChatContextMarkdown(history: ChatMessage[], newMessage: string): string {
      const lines: string[] = [
        "# Board Chat — Direct Conversation",
        "",
        "You are in a LIVE CHAT with the Board of Directors (human operator) via the Paperclip control panel.",
        "IMPORTANT: Respond directly and naturally to what the Board says. Answer questions, provide information, and have a normal conversation.",
        "Do NOT output templates or placeholders. Do NOT ask the Board to paste items. Just respond to their message.",
        "",
      ];

      if (history.length > 0) {
        lines.push("## Recent conversation");
        lines.push("");
        for (const msg of history.slice(-20)) {
          const role = msg.role === "user" ? "Board" : "CEO";
          lines.push(`**${role}**: ${msg.content}`);
          lines.push("");
        }
      }

      lines.push("## New message from the Board");
      lines.push("");
      lines.push(newMessage);
      lines.push("");
      lines.push("Respond to this message now.");

      return lines.join("\n");
    },

    // ---- Stream a CEO response via heartbeat agent execution ----

    async *streamResponse(
      companyId: string,
    ): AsyncGenerator<{
      type: "token" | "done" | "error";
      token?: string;
      fullContent?: string;
      runId?: string;
    }> {
      const ceoAgentId = await this.getCeoAgentId(companyId);
      if (!ceoAgentId) {
        yield { type: "token", token: "No CEO agent found for this company. Please create an agent with the CEO role first." };
        yield { type: "done", fullContent: "No CEO agent found for this company." };
        return;
      }

      // Build chat context from history
      const history = await this.getHistory(companyId, 20);
      const lastUserMessage = history.filter(m => m.role === "user").pop();
      const chatMarkdown = this.buildChatContextMarkdown(
        history.slice(0, -1), // exclude the just-stored user message from history
        lastUserMessage?.content ?? "",
      );

      // Subscribe to live events BEFORE invoking so we don't miss any
      let fullContent = "";
      let resolveStream: (() => void) | null = null;
      let rejectStream: ((err: Error) => void) | null = null;
      const tokenQueue: Array<{ type: "token" | "done" | "error"; token?: string; fullContent?: string; runId?: string }> = [];
      let streamDone = false;
      let runId: string | null = null;

      const streamPromise = new Promise<void>((resolve, reject) => {
        resolveStream = resolve;
        rejectStream = reject;
      });

      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event: LiveEvent) => {
        if (!runId) return;
        const payload = event.payload as Record<string, unknown>;
        if (payload.runId !== runId) return;

        if (event.type === "heartbeat.run.log") {
          const chunk = String(payload.chunk ?? "");
          const stream = String(payload.stream ?? "stdout");
          if (stream === "stdout" && chunk) {
            // Parse OpenCode JSON output format — extract text content only
            const extractedText = extractOpenCodeText(chunk);
            if (extractedText) {
              fullContent += extractedText;
              tokenQueue.push({ type: "token", token: extractedText });
            }
          }
        } else if (event.type === "heartbeat.run.status") {
          const status = String(payload.status ?? "");
          if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
            if (status === "failed") {
              const error = payload.error ? String(payload.error) : "Agent execution failed";
              tokenQueue.push({ type: "error", token: error });
            }
            streamDone = true;
            tokenQueue.push({ type: "done", fullContent, runId: runId ?? undefined });
            resolveStream?.();
          }
        }
      });

      try {
        // Invoke the CEO agent via heartbeat
        const run = await heartbeat.invoke(
          ceoAgentId,
          "on_demand",
          {
            source: "chat",
            wakeReason: "chat_message",
            paperclipSessionHandoffMarkdown: chatMarkdown,
          },
          "manual",
          { actorType: "user" },
        );

        if (!run) {
          unsubscribe();
          yield { type: "token", token: "CEO agent could not be invoked. It may be paused, at capacity, or over budget." };
          yield { type: "done", fullContent: "CEO agent could not be invoked." };
          return;
        }

        runId = run.id;

        // Yield tokens as they arrive, with a timeout
        const TIMEOUT_MS = 120_000; // 2 minutes
        const startTime = Date.now();

        while (!streamDone) {
          // Flush any queued tokens
          while (tokenQueue.length > 0) {
            const item = tokenQueue.shift()!;
            yield item;
            if (item.type === "done") {
              unsubscribe();
              return;
            }
          }

          // Check timeout
          if (Date.now() - startTime > TIMEOUT_MS) {
            unsubscribe();
            yield { type: "token", token: "\n\n(Response timed out after 2 minutes)" };
            yield { type: "done", fullContent: fullContent + "\n\n(Response timed out)" };
            return;
          }

          // Wait briefly for more events
          await new Promise((r) => setTimeout(r, 50));
        }

        // Flush remaining tokens
        while (tokenQueue.length > 0) {
          yield tokenQueue.shift()!;
        }
      } catch (err) {
        logger.error({ err }, "Chat agent invocation error");
        yield { type: "error", token: "Failed to invoke CEO agent" };
        yield { type: "done", fullContent: fullContent || "Failed to invoke CEO agent" };
      } finally {
        unsubscribe();
      }
    },

    // ---- CEO agent ID resolver ----

    async getCeoAgentId(companyId: string): Promise<string | null> {
      const ceo = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
        .then((r) => r[0] ?? null);
      return ceo?.id ?? null;
    },
  };
}
