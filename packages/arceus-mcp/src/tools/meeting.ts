import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "@arceus/contracts";
import type { McpContext } from "../context.js";
import type { ArceusHttpClient } from "../http-client.js";
import { deriveIdempotencyKey, toMcpContent } from "../envelope.js";

const MEETINGS = "/api/internal/v1/meetings";

export const registerMeetingTools = (
  server: McpServer,
  ctx: McpContext,
  client: ArceusHttpClient
): void => {
  server.registerTool(
    "meeting_record",
    {
      description: "Record a meeting with agenda, decisions, and learnings. CEO/PM/skills_lead only.",
      inputSchema: {
        type: z.enum(["daily_sync", "eval_triggered", "escalation"]),
        facilitatorRole: z.string().min(1).max(64),
        participantRoles: z.array(z.string()).min(1).max(16),
        summary: z.string().min(1).max(500),
        agenda: z.array(
          z.object({
            topic: z.string().min(1).max(200),
            type: z.enum(["update", "blocker", "question", "proposal"]),
            content: z.string().min(1).max(4000),
            raisedByRole: z.string().min(1).max(64),
            relatedTaskId: z.string().nullable().optional(),
            needsBoardApproval: z.boolean().optional(),
          })
        ).min(1).max(32),
        decisions: z.array(
          z.object({
            description: z.string().min(1).max(2000),
            decidedByRoles: z.array(z.string().min(1)).min(1),
            impactIds: z.array(z.string()).default([]),
          })
        ).optional(),
        learnings: z.array(
          z.object({
            role: z.string().min(1).max(64),
            content: z.string().min(1).max(2000),
            promotedToSummary: z.boolean().optional(),
          })
        ).optional(),
        taskModifications: z.array(
          z.object({
            taskId: z.string().min(1),
            modificationType: z.enum(["assign", "reprioritize", "reassign", "cancel", "decompose_further", "unblock"]),
            details: z.string().min(1).max(2000),
            assignedRole: z.string().nullable().optional(),
            priority: z.enum(["low", "medium", "high", "critical"]).nullable().optional(),
            resultingStatus: z.enum(["created", "planned", "in_progress", "verifying", "blocked", "completed", "failed", "cancelled"]).nullable().optional(),
          })
        ).optional(),
        memoryModifications: z.array(
          z.object({
            role: z.string().min(1).max(64),
            modificationType: z.enum(["current_focus", "recent_learning", "active_pattern", "open_blocker", "important_decision", "clear_blocker"]),
            content: z.string().min(1).max(2000),
          })
        ).optional(),
      },
    },
    async (args) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: MEETINGS,
        body: args,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "meeting_record", args),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "meeting_get",
    {
      description:
        "Read a single meeting by ID, including agenda items, decisions, learnings, and contributions. " +
        "Use to inspect the outcome of a meeting you participated in or to review prior decisions.",
      inputSchema: {
        meetingId: z.string().min(1).describe("Meeting ID (e.g. 'mtg_abc123...')"),
      },
    },
    async ({ meetingId }) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "GET",
        path: `${MEETINGS}/${encodeURIComponent(meetingId)}`,
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "meeting_request_decision",
    {
      description:
        "Open an asynchronous decision meeting on a topic. Other participants can contribute positions " +
        "via meeting_contribute before a decision is recorded. Use for cross-role escalations that don't " +
        "require synchronous discussion.",
      inputSchema: {
        topic: z.string().min(1).max(200).describe("Short title for the decision needed"),
        description: z.string().min(1).max(4000).describe("Context, options under consideration, and what input is needed"),
        participantRoles: z.array(z.string()).min(1).max(8).describe("Roles whose input is requested"),
        deadline: z.string().optional().describe("ISO timestamp by which a decision is needed"),
      },
    },
    async (args) => {
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${MEETINGS}/request-decision`,
        body: args,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "meeting_request_decision", args),
      });
      return toMcpContent(res.data);
    }
  );

  server.registerTool(
    "meeting_contribute",
    {
      description:
        "Attach a position or supporting artifact to an open decision meeting. Use when invited as a " +
        "participant to a meeting opened by meeting_request_decision.",
      inputSchema: {
        meetingId: z.string().min(1),
        artifactId: z.string().min(1).describe("Artifact backing this contribution (e.g. an analysis or proposal)"),
        position: z.string().max(2000).optional().describe("Brief stance or recommendation"),
      },
    },
    async ({ meetingId, artifactId, position }) => {
      const body = { artifactId, position };
      const res = await client.request<ToolResult<unknown>>({
        method: "POST",
        path: `${MEETINGS}/${encodeURIComponent(meetingId)}/contribute`,
        body,
        idempotencyKey: deriveIdempotencyKey(ctx.beatId, "meeting_contribute", { meetingId, ...body }),
      });
      return toMcpContent(res.data);
    }
  );
};
