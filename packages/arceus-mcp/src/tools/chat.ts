import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const CHAT_CARDS = "/api/internal/v1/chat/cards";
const MEETING_REQUEST = "/api/internal/v1/meetings/request";

/**
 * Spec 35 — chat surface tools exposed to the CEO chat session.
 *
 * `chat_emit_card` is the *only* way Avery can render an interactive card
 * in the user's chat. The wire is fire-and-forget: the tool returns the
 * card id; user reactions arrive on a future turn as a synthetic user
 * message (see `POST /api/chat/cards/:id/decide`).
 */
export const registerChatTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "chat_emit_card",
    {
      description:
        "Emit an interactive card into the CEO chat. Use this for the bootstrap sequence and ad-hoc interactions only: idea_refine, name_suggest, hiring_slate, sprint_plan, decision, approval_request, memory_capture, meeting_summary. NEVER emit strategy_proposal, welcome_brief, mission_brief, clarifying_question, status_update or sprint_proposal — those are produced automatically by the system from your reply text and emitting them here will cause duplicate cards. Fire-and-forget — the user's reaction arrives later as a synthetic user message.",
      inputSchema: {
        type: z.enum([
          "idea_refine",
          "name_suggest",
          "hiring_slate",
          "sprint_plan",
          "decision",
          "approval_request",
          "memory_capture",
          "meeting_summary",
        ]),
        payload: z.record(z.unknown()),
      },
    },
    async ({ type, payload }) => {
      const body = { type, payload };
      const res = await client.request<ToolResult>({
        method: "POST",
        path: CHAT_CARDS,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "chat_emit_card", body),
      });
      return toMcpContent(res.data);
    }
  );

  /**
   * Spec 35 §5 — async "let me check with the team" meetings.
   * CEO calls this to schedule a real ad-hoc meeting with named teammates.
   * Returns immediately; pipeline runs async; on completion a
   * `meeting_summary` card is auto-emitted into chat.
   */
  server.registerTool(
    "meeting_request",
    {
      description:
        "Schedule an async meeting with teammates and return immediately. Use when you need other agents' input before answering. The pipeline runs in the background; when complete, a meeting_summary card appears in the chat automatically. CEO-only.",
      inputSchema: {
        topic: z.string().min(1).max(200).describe("Short title for the meeting"),
        attendees: z
          .array(z.string().min(1))
          .min(1)
          .max(8)
          .describe("Roles whose input you want (e.g. ['cto','pm'])"),
        question: z
          .string()
          .min(1)
          .max(4000)
          .describe("The question or topic the team should weigh in on"),
      },
    },
    async (args) => {
      const res = await client.request<ToolResult>({
        method: "POST",
        path: MEETING_REQUEST,
        body: args,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "meeting_request", args),
      });
      return toMcpContent(res.data);
    }
  );
};
